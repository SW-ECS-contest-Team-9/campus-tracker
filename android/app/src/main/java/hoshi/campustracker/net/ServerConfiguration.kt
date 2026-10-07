package hoshi.campustracker.net

import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

@Serializable
enum class ServerScheme(val title: String) { http("HTTP"), https("HTTPS") }

/** The only place server addresses are built (§8.1): no hard-coded host, IP or port anywhere else. */
@Serializable
data class ServerConfiguration(val scheme: ServerScheme = ServerScheme.http, val host: String, val port: Int = 3000) {
    val baseUrl: HttpUrl
        get() = HttpUrl.Builder().scheme(scheme.name).host(host).port(port).build()

    /** Owner key stored with queued sessions (§12-6). */
    val serverKey: String get() = "${scheme.name}://$host:$port"

    fun url(path: String): HttpUrl = baseUrl.newBuilder().encodedPath(path).build()

    /** Fallback only when no `webSocketURL` from login is stored. */
    val defaultWebSocketUrl: String
        get() = "${if (scheme == ServerScheme.https) "wss" else "ws"}://${baseUrl.host.let { if (it.contains(':')) "[$it]" else it }}:$port/ws/collector"

    companion object {
        /** Validates user input with the iOS messages. */
        fun validate(scheme: ServerScheme, hostInput: String, portInput: String): Result<ServerConfiguration> {
            val host = hostInput.trim()
            if (host.isEmpty()) return Result.failure(ConfigurationError("Enter a server address."))
            if (host.contains("://") || host.contains('/') || host.any { it.isWhitespace() }) {
                return Result.failure(ConfigurationError("Enter only a host or IP address."))
            }
            val port = portInput.trim().toIntOrNull()
            if (port == null || port !in 1..65535) return Result.failure(ConfigurationError("Port must be between 1 and 65535."))
            val valid = "${scheme.name}://$host:$port/".toHttpUrlOrNull()
            if (valid == null) return Result.failure(ConfigurationError("Enter a valid server address."))
            return Result.success(ServerConfiguration(scheme, host, port))
        }

        fun validateCollectorId(input: String): Result<String> {
            val id = input.trim()
            if (id.isEmpty()) return Result.failure(ConfigurationError("Enter a collector ID."))
            if (id.length > 32) return Result.failure(ConfigurationError("Collector ID must be at most 32 characters."))
            return Result.success(id)
        }
    }
}

class ConfigurationError(message: String) : Exception(message)
