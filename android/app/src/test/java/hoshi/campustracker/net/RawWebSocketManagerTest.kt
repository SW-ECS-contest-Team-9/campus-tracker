package hoshi.campustracker.net

import hoshi.campustracker.core.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class RawWebSocketManagerTest {
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor().asCoroutineDispatcher())
    private val manager = RawWebSocketManager(OkHttpClient(), scope)
    private val events = LinkedBlockingQueue<String>()
    private val rejections = LinkedBlockingQueue<AuthRejection>()

    @Before fun setUp() {
        L.sink = { _, _, _, _ -> }
        server.start()
        manager.setListener(object : CollectorSocketListener {
            override fun onConnected() { events += "connected" }
            override fun onDisconnected() { events += "disconnected" }
            override fun onMessage(text: String) { events += "message:$text" }
        })
        manager.onAuthRejected = { rejections += it }
    }

    @After fun tearDown() {
        runBlocking { manager.disconnect().join() }
        server.close()
    }

    /** Server side that answers a close frame, like the real backend. */
    private open class EchoClose : WebSocketListener() {
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
        }
    }

    private fun url() = "ws://${server.hostName}:${server.port}/ws/collector"

    @Test
    fun sendsAuthHeadersAndDeliversMessages() {
        val serverSide = LinkedBlockingQueue<WebSocket>()
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : EchoClose() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSide += webSocket
            }
        }).build())
        manager.connect(SocketParams(url(), "token-1", "Device-ABC"))
        assertEquals("connected", events.poll(5, TimeUnit.SECONDS))
        val request = server.takeRequest()
        assertEquals("Bearer token-1", request.headers["Authorization"])
        assertEquals("Device-ABC", request.headers["X-Device-ID"])
        assertEquals(ConnectionState.Connected, manager.state.value)
        serverSide.poll(5, TimeUnit.SECONDS)!!.send("""{"type":"ack"}""")
        assertEquals("""message:{"type":"ack"}""", events.poll(5, TimeUnit.SECONDS))
    }

    @Test
    fun expiredTokenIsReportedAsAuthRejection() {
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":{"code":"TOKEN_EXPIRED","message":"expired"}}""").build())
        manager.connect(SocketParams(url(), "old", "d"))
        val rejection = rejections.poll(5, TimeUnit.SECONDS)!!
        assertEquals(AuthRejection(401, "TOKEN_EXPIRED"), rejection)
        assertEquals(ConnectionState.Reconnecting, manager.state.value)
    }

    @Test
    fun wrongPathFailsWithoutRetrying() {
        server.enqueue(MockResponse.Builder().code(404).body("""{"error":{"code":"WS_PATH_NOT_FOUND","message":"x"}}""").build())
        manager.connect(SocketParams(url(), "t", "d"))
        runBlocking { withTimeout(5_000) { manager.state.first { it is ConnectionState.Failed } } }
        Thread.sleep(1_500)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun collectorDeletedCloseCodeIsTreatedAsDeviceNotFound() {
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.close(4004, "Collector deleted")
            }
        }).build())
        manager.connect(SocketParams(url(), "t", "d"))
        assertEquals(AuthRejection(404, "DEVICE_NOT_FOUND"), rejections.poll(5, TimeUnit.SECONDS))
        assertEquals("connected", events.poll(1, TimeUnit.SECONDS))
        assertEquals("disconnected", events.poll(1, TimeUnit.SECONDS))
    }

    @Test
    fun dropsReconnectAfterOneSecond() {
        server.enqueue(MockResponse.Builder().code(500).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(EchoClose()).build())
        manager.connect(SocketParams(url(), "t", "d"))
        val started = System.nanoTime()
        assertEquals("connected", events.poll(5, TimeUnit.SECONDS))
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertEquals(true, elapsedMs >= 900)
        assertEquals(2, server.requestCount)
    }
}
