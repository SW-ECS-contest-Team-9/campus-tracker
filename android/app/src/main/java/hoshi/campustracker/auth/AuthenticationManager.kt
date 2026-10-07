package hoshi.campustracker.auth

import hoshi.campustracker.core.L
import hoshi.campustracker.model.DeviceInfo
import hoshi.campustracker.net.ApiError
import hoshi.campustracker.net.AuthRejection
import hoshi.campustracker.net.CollectorApi
import hoshi.campustracker.net.ConnectionState
import hoshi.campustracker.net.LoginRequest
import hoshi.campustracker.net.LoginResponse
import hoshi.campustracker.net.RawWebSocketManager
import hoshi.campustracker.net.ServerConfiguration
import hoshi.campustracker.net.ServerScheme
import hoshi.campustracker.net.SocketParams
import hoshi.campustracker.sync.TelemetrySyncCoordinator
import hoshi.campustracker.sync.UploadOwner
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed class AuthState {
    data object Unknown : AuthState()
    data object SignedOut : AuthState()
    data object Authenticating : AuthState()
    data class Authenticated(val collectorId: String) : AuthState()
    data class Failed(val message: String) : AuthState()
}

/**
 * Login, token storage and the automatic re-login on auth rejection (§8.2/§8.3). Blocking HTTP runs on [io], which
 * must be single-threaded so logins never overlap.
 */
class AuthenticationManager(
    private val settings: SettingsStore,
    private val tokens: TokenStore,
    private val api: CollectorApi,
    private val socket: RawWebSocketManager,
    private val sync: TelemetrySyncCoordinator,
    private val device: DeviceInfo,
    private val ioDispatcher: CoroutineDispatcher,
) {
    private val io = CoroutineScope(SupervisorJob() + ioDispatcher)

    companion object {
        const val UNREGISTERED_COLLECTOR = "등록되지 않은 Collector ID"
    }

    private val _state = MutableStateFlow<AuthState>(AuthState.Unknown)
    val state: StateFlow<AuthState> = _state

    private val _configuration = MutableStateFlow<ServerConfiguration?>(null)
    val configuration: StateFlow<ServerConfiguration?> = _configuration

    private val _collectorId = MutableStateFlow<String?>(null)
    /** Saved collector ID (for the setup form), not necessarily authenticated. */
    val savedCollectorId: StateFlow<String?> = _collectorId

    /** True between a successful automatic re-login and the first open connection with its token. */
    @Volatile private var reloginAwaitingConfirmation = false

    val authenticatedCollectorId: String? get() = (state.value as? AuthState.Authenticated)?.collectorId

    val currentOwner: UploadOwner?
        get() {
            val id = authenticatedCollectorId ?: return null
            val server = configuration.value ?: return null
            return UploadOwner(id, server.serverKey)
        }

    init {
        socket.onAuthRejected = { rejection -> io.launch { handleRejection(rejection) } }
        io.launch {
            socket.state.collect { if (it == ConnectionState.Connected) reloginAwaitingConfirmation = false }
        }
    }

    /** App start: a stored collector ID + token means authenticated; connect right away. */
    fun restore() = io.launch {
        val current = settings.currentBlocking()
        _configuration.value = current.server
        _collectorId.value = current.collectorId
        val token = tokens.load()
        val server = current.server
        val collector = current.collectorId
        if (server != null && collector != null && token != null) {
            _state.value = AuthState.Authenticated(collector)
            sync.setOwner(UploadOwner(collector, server.serverKey))
            socket.connect(SocketParams(current.webSocketUrl ?: server.defaultWebSocketUrl, token, device.deviceId))
        } else {
            _state.value = AuthState.SignedOut
            sync.setOwner(null)
        }
    }

    suspend fun testConnection(scheme: ServerScheme, host: String, port: String): String = withContext(ioDispatcher) {
        val configuration = ServerConfiguration.validate(scheme, host, port).getOrElse { return@withContext it.message.orEmpty() }
        try {
            api.health(configuration)
            "Server reachable."
        } catch (e: ApiError) {
            e.message.orEmpty()
        }
    }

    fun login(scheme: ServerScheme, host: String, port: String, collectorIdInput: String) = io.launch {
        val configuration = ServerConfiguration.validate(scheme, host, port).getOrElse {
            _state.value = AuthState.Failed(it.message.orEmpty()); return@launch
        }
        val collectorId = ServerConfiguration.validateCollectorId(collectorIdInput).getOrElse {
            _state.value = AuthState.Failed(it.message.orEmpty()); return@launch
        }
        settings.saveServer(configuration, collectorId)
        _configuration.value = configuration
        _collectorId.value = collectorId
        _state.value = AuthState.Authenticating
        try {
            val response = requestLogin(configuration, collectorId)
            applyLogin(configuration, response)
        } catch (e: ApiError) {
            val message = if (e is ApiError.Http && e.code == "COLLECTOR_NOT_FOUND") UNREGISTERED_COLLECTOR else e.message.orEmpty()
            _state.value = AuthState.Failed(message)
        }
    }

    /** Saves edited settings; changing the server or collector signs out (§8.2). Returns the message to show. */
    suspend fun saveServerSettings(scheme: ServerScheme, host: String, port: String, collectorIdInput: String): String =
        withContext(ioDispatcher) {
            val configuration = ServerConfiguration.validate(scheme, host, port).getOrElse { return@withContext it.message.orEmpty() }
            val collectorId = ServerConfiguration.validateCollectorId(collectorIdInput).getOrElse { return@withContext it.message.orEmpty() }
            val changed = configuration != _configuration.value || !collectorId.equals(_collectorId.value, ignoreCase = false)
            if (changed) signOut()
            settings.saveServer(configuration, collectorId)
            _configuration.value = configuration
            _collectorId.value = collectorId
            "Saved. If server or collector changed, sign in again."
        }

    fun logout() = io.launch { signOut() }

    /** "Reset Server and Account": sign out and forget server and collector. */
    fun reset() = io.launch {
        signOut()
        settings.saveServer(null, null)
        settings.saveWebSocketUrl(null)
        _configuration.value = null
        _collectorId.value = null
    }

    private suspend fun signOut() {
        socket.disconnect()
        tokens.clear()
        reloginAwaitingConfirmation = false
        sync.setOwner(null)
        _state.value = AuthState.SignedOut
    }

    private fun requestLogin(configuration: ServerConfiguration, collectorId: String): LoginResponse =
        api.login(
            configuration,
            LoginRequest(
                collectorId = collectorId, deviceId = device.deviceId, deviceModel = device.deviceModel,
                systemVersion = device.systemVersion, appVersion = device.appVersion,
            ),
        )

    private suspend fun applyLogin(configuration: ServerConfiguration, response: LoginResponse) {
        tokens.save(response.accessToken)
        settings.saveWebSocketUrl(response.webSocketURL)
        settings.saveServer(configuration, response.collectorId)
        _collectorId.value = response.collectorId
        _state.value = AuthState.Authenticated(response.collectorId)
        sync.setOwner(UploadOwner(response.collectorId, configuration.serverKey))
        socket.connect(SocketParams(response.webSocketURL ?: configuration.defaultWebSocketUrl, response.accessToken, device.deviceId))
        L.i("Auth", "logged in collector=${response.collectorId}")
    }

    /** Auth rejection or close 4004: log in once again with the stored collector + device ID (no password exists). */
    private suspend fun handleRejection(rejection: AuthRejection) {
        val configuration = _configuration.value
        val collectorId = _collectorId.value
        if (_state.value !is AuthState.Authenticated || configuration == null || collectorId == null) {
            socket.disconnect()
            return
        }
        if (reloginAwaitingConfirmation) {
            L.w("Auth", "rejected again right after re-login code=${rejection.code}; stopping")
            reloginAwaitingConfirmation = false
            socket.disconnect(ConnectionState.Failed("Collector authentication failed."))
            _state.value = AuthState.Failed("Collector authentication failed.")
            return
        }
        L.i("Auth", "connection rejected code=${rejection.code}; re-login")
        try {
            val response = requestLogin(configuration, collectorId)
            reloginAwaitingConfirmation = true
            applyLogin(configuration, response)
        } catch (e: ApiError) {
            when {
                e is ApiError.Http && (e.code == "COLLECTOR_NOT_FOUND" || e.status == 404) -> {
                    socket.disconnect(ConnectionState.Failed(UNREGISTERED_COLLECTOR))
                    _state.value = AuthState.Failed(UNREGISTERED_COLLECTOR)
                }
                e is ApiError.Http && e.status in 400..499 -> {
                    socket.disconnect(ConnectionState.Failed(e.message.orEmpty()))
                    _state.value = AuthState.Failed(e.message.orEmpty())
                }
                else -> socket.retryLater()
            }
        }
    }
}
