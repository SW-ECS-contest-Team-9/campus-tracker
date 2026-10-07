package hoshi.campustracker.net

import hoshi.campustracker.core.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

data class SocketParams(val url: String, val accessToken: String, val deviceId: String)

/** Why the server refused the connection; the auth layer decides what to do (§3.3 / §8.3). */
data class AuthRejection(val status: Int, val code: String)

/**
 * Standard RFC 6455 WebSocket to `/ws/collector` (not Socket.IO). State changes come only from real socket events.
 * Reconnects after min(2^(n−1), 15) s. All mutable state is confined to [scope] (single-threaded).
 */
class RawWebSocketManager(
    baseClient: OkHttpClient,
    private val scope: CoroutineScope,
) : CollectorSocket {
    companion object {
        private const val TAG = "WebSocket"
        private val AUTH_CODES = setOf("TOKEN_REQUIRED", "INVALID_TOKEN", "TOKEN_EXPIRED", "DEVICE_MISMATCH", "DEVICE_NOT_FOUND")
        const val CLOSE_COLLECTOR_DELETED = 4004

        fun reconnectDelaySeconds(attempt: Int): Long = minOf(1L shl (attempt - 1).coerceIn(0, 4), 15L)
    }

    private val client = baseClient.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    override val state: StateFlow<ConnectionState> = _state

    /** Called on [scope] when the upgrade is refused for an auth reason or the collector was deleted (4004). */
    var onAuthRejected: ((AuthRejection) -> Unit)? = null

    @Volatile private var webSocket: WebSocket? = null
    private var listener: CollectorSocketListener? = null
    private var params: SocketParams? = null
    private var generation = 0L
    private var attempts = 0
    private var stopped = true
    private var reconnectJob: Job? = null
    private var wasOpen = false

    override fun setListener(listener: CollectorSocketListener) {
        this.listener = listener
    }

    override fun send(text: String): Boolean {
        if (_state.value != ConnectionState.Connected) return false
        return webSocket?.send(text) ?: false
    }

    fun connect(newParams: SocketParams) = scope.launch {
        params = newParams
        stopped = false
        attempts = 0
        reconnectJob?.cancel()
        open(ConnectionState.Connecting)
    }

    /** Logout / reset: closes and does not reconnect. */
    fun disconnect(finalState: ConnectionState = ConnectionState.Disconnected) = scope.launch {
        stopped = true
        reconnectJob?.cancel()
        generation++
        closeCurrent()
        _state.value = finalState
    }

    /** Keeps retrying on the normal backoff (e.g. re-login hit a network error). */
    fun retryLater() = scope.launch { if (!stopped) scheduleReconnect() }

    private fun open(stateWhileOpening: ConnectionState) {
        val p = params ?: return
        generation++
        val gen = generation
        closeCurrent()
        _state.value = stateWhileOpening
        val request = try {
            Request.Builder()
                .url(p.url)
                .header("Authorization", "Bearer ${p.accessToken}")
                .header("X-Device-ID", p.deviceId)
                .build()
        } catch (e: IllegalArgumentException) {
            L.e(TAG, "invalid WebSocket URL", e)
            stopped = true
            _state.value = ConnectionState.Failed("Invalid WebSocket address.")
            return
        }
        L.i(TAG, "connecting url=${request.url.host}:${request.url.port}${request.url.encodedPath}")
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                scope.launch { if (gen == generation) handleOpen() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { if (gen == generation) listener?.onMessage(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch { if (gen == generation) handleDrop(closeCode = code, rejection = null) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val rejection = response?.let { r ->
                    val body = runCatching { r.body.string() }.getOrNull()
                    val (code, _) = ApiError.parseErrorBody(body)
                    r.code to code
                }
                scope.launch {
                    if (gen != generation) return@launch
                    L.w(TAG, "failure ${t.javaClass.simpleName} status=${rejection?.first} code=${rejection?.second}")
                    handleDrop(closeCode = null, rejection = rejection)
                }
            }
        })
    }

    private fun handleOpen() {
        attempts = 0
        wasOpen = true
        _state.value = ConnectionState.Connected
        L.i(TAG, "connected")
        listener?.onConnected()
    }

    private fun handleDrop(closeCode: Int?, rejection: Pair<Int, String?>?) {
        webSocket = null
        if (wasOpen) {
            wasOpen = false
            listener?.onDisconnected()
        }
        if (stopped) {
            _state.value = ConnectionState.Disconnected
            return
        }
        if (closeCode == CLOSE_COLLECTOR_DELETED) {
            _state.value = ConnectionState.Reconnecting
            onAuthRejected?.invoke(AuthRejection(404, "DEVICE_NOT_FOUND"))
            return
        }
        if (rejection != null) {
            val (status, code) = rejection
            if (code == "WS_PATH_NOT_FOUND") {
                stopped = true
                _state.value = ConnectionState.Failed("WebSocket endpoint not found. Check the server address.")
                return
            }
            if (code in AUTH_CODES || status == 401 || status == 403) {
                _state.value = ConnectionState.Reconnecting
                onAuthRejected?.invoke(AuthRejection(status, code ?: "HTTP_$status"))
                return
            }
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        attempts += 1
        val delaySeconds = reconnectDelaySeconds(attempts)
        _state.value = ConnectionState.Reconnecting
        L.i(TAG, "reconnect in ${delaySeconds}s attempt=$attempts")
        reconnectJob = scope.launch {
            delay(delaySeconds * 1_000)
            if (!stopped) open(ConnectionState.Reconnecting)
        }
    }

    private fun closeCurrent() {
        val current = webSocket ?: return
        webSocket = null
        if (wasOpen) {
            wasOpen = false
            listener?.onDisconnected()
        }
        // Graceful close; force it if the peer does not answer the close frame within a second.
        if (current.close(1000, null)) {
            scope.launch { delay(1_000); current.cancel() }
        } else {
            current.cancel()
        }
    }
}
