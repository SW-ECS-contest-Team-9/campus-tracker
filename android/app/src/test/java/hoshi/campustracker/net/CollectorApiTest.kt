package hoshi.campustracker.net

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CollectorApiTest {
    private val server = MockWebServer()
    private lateinit var config: ServerConfiguration
    private val api = CollectorApi(OkHttpClient())

    @Before fun setUp() {
        server.start()
        config = ServerConfiguration(ServerScheme.http, server.hostName, server.port)
    }

    @After fun tearDown() = server.close()

    @Test
    fun loginSendsTheContractBodyAndReadsTheResponse() {
        server.enqueue(
            MockResponse.Builder().code(200).body(
                """{"collectorId":"C03","accessToken":"t","socketUrl":"x","socketNamespace":"/collector","webSocketURL":"ws://h:3000/ws/collector","new":1}""",
            ).build(),
        )
        val response = api.login(config, LoginRequest("c03", "device-1", deviceModel = "samsung SM-S918N", systemVersion = "14", appVersion = "1.0"))
        assertEquals("C03", response.collectorId)
        assertEquals("ws://h:3000/ws/collector", response.webSocketURL)
        val request = server.takeRequest()
        assertEquals("/api/v1/collectors/login", request.url.encodedPath)
        val body = request.body!!.utf8()
        assertTrue(body.contains("\"platform\":\"android\""))
        assertTrue(body.contains("\"deviceId\":\"device-1\""))
    }

    @Test
    fun loginMapsServerErrors() {
        server.enqueue(MockResponse.Builder().code(404).body("""{"error":{"code":"COLLECTOR_NOT_FOUND","message":"no"}}""").build())
        val error = runCatching { api.login(config, LoginRequest("C99", "d", deviceModel = "m", systemVersion = "1", appVersion = "1")) }.exceptionOrNull()
        assertTrue(error is ApiError.Http)
        assertEquals("COLLECTOR_NOT_FOUND", (error as ApiError.Http).code)
        assertEquals("The collector or server endpoint was not found.", error.message)
    }

    @Test
    fun unreadableBodyAndUnreachableServer() {
        server.enqueue(MockResponse.Builder().code(200).body("not json").build())
        assertTrue(runCatching { api.login(config, LoginRequest("C1", "d", deviceModel = "m", systemVersion = "1", appVersion = "1")) }.exceptionOrNull() is ApiError.Unreadable)
        server.close()
        assertTrue(runCatching { api.health(config) }.exceptionOrNull() is ApiError.CannotConnect)
    }
}
