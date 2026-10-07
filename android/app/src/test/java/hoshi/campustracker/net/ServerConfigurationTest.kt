package hoshi.campustracker.net

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerConfigurationTest {
    private fun error(host: String, port: String = "3000") =
        ServerConfiguration.validate(ServerScheme.http, host, port).exceptionOrNull()?.message

    @Test
    fun validationMessagesMatchIos() {
        assertEquals("Enter a server address.", error("  "))
        assertEquals("Enter only a host or IP address.", error("http://1.2.3.4"))
        assertEquals("Enter only a host or IP address.", error("1.2.3.4/api"))
        assertEquals("Enter only a host or IP address.", error("1.2 .3.4"))
        assertEquals("Port must be between 1 and 65535.", error("1.2.3.4", "0"))
        assertEquals("Port must be between 1 and 65535.", error("1.2.3.4", "70000"))
        assertEquals("Port must be between 1 and 65535.", error("1.2.3.4", "abc"))
        assertEquals("Enter a valid server address.", error("[abc"))
        assertEquals("Enter a collector ID.", ServerConfiguration.validateCollectorId("   ").exceptionOrNull()?.message)
        assertEquals("C03", ServerConfiguration.validateCollectorId(" C03 ").getOrThrow())
    }

    @Test
    fun urlsAreBuiltFromTheConfiguration() {
        val c = ServerConfiguration.validate(ServerScheme.http, "100.93.21.92", "3000").getOrThrow()
        assertEquals("http://100.93.21.92:3000/health", c.url("/health").toString())
        assertEquals("ws://100.93.21.92:3000/ws/collector", c.defaultWebSocketUrl)
        assertEquals("http://100.93.21.92:3000", c.serverKey)
        val s = ServerConfiguration.validate(ServerScheme.https, "example.org", "443").getOrThrow()
        assertEquals("wss://example.org:443/ws/collector", s.defaultWebSocketUrl)
    }

    @Test
    fun reconnectDelaySequence() {
        assertEquals(listOf(1L, 2L, 4L, 8L, 15L, 15L, 15L), (1..7).map { RawWebSocketManager.reconnectDelaySeconds(it) })
    }

    @Test
    fun httpErrorMessages() {
        assertEquals("The server rejected the request.", ApiError.messageFor(400))
        assertEquals("Collector authentication failed.", ApiError.messageFor(401))
        assertEquals("The collector or server endpoint was not found.", ApiError.messageFor(404))
        assertEquals("The server reported a collector conflict.", ApiError.messageFor(409))
        assertEquals("The server could not complete the request.", ApiError.messageFor(503))
    }
}
