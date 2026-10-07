package hoshi.campustracker.net

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.core.L
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

@Serializable
data class LoginRequest(
    val collectorId: String,
    val deviceId: String,
    val platform: String = "android",
    val deviceModel: String,
    val systemVersion: String,
    val appVersion: String,
)

@Serializable
data class LoginResponse(
    val collectorId: String,
    val accessToken: String,
    val webSocketURL: String? = null,
    val socketUrl: String? = null,
    val socketNamespace: String? = null,
)

/** HTTP-level failures with the iOS user messages (§3.2). */
sealed class ApiError(message: String) : Exception(message) {
    class Http(val status: Int, val code: String?, serverMessage: String?) : ApiError(messageFor(status)) {
        val detail: String? = serverMessage
    }
    class CannotConnect : ApiError("Cannot connect to the server. Check the address, port, Wi-Fi, and server status.")
    class Timeout : ApiError("The request timed out. Check the server connection.")
    class Unreadable : ApiError("The server returned an unreadable response.")

    companion object {
        fun messageFor(status: Int): String = when {
            status == 400 -> "The server rejected the request."
            status == 401 -> "Collector authentication failed."
            status == 404 -> "The collector or server endpoint was not found."
            status == 409 -> "The server reported a collector conflict."
            status >= 500 -> "The server could not complete the request."
            else -> "The server returned HTTP $status."
        }

        /** `{ "error": { "code", "message" } }` → code, message. */
        fun parseErrorBody(body: String?): Pair<String?, String?> {
            if (body.isNullOrBlank()) return null to null
            val error = runCatching { AppJson.parseToJsonElement(body).jsonObject["error"] as? JsonObject }.getOrNull() ?: return null to null
            return (error["code"] as? JsonPrimitive)?.contentOrNull to (error["message"] as? JsonPrimitive)?.contentOrNull
        }
    }
}

class CollectorApi(private val baseClient: OkHttpClient) {
    private val loginClient = baseClient.newBuilder().callTimeout(8, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS).build()
    private val healthClient = baseClient.newBuilder().callTimeout(5, TimeUnit.SECONDS).connectTimeout(5, TimeUnit.SECONDS).build()

    /** `GET /health` → 200 `{status, database}` (Test Connection). Blocking; call off the main thread. */
    fun health(configuration: ServerConfiguration) {
        val request = Request.Builder().url(configuration.url("/health")).get().build()
        execute(healthClient, request)
    }

    /** `POST /api/v1/collectors/login`. Blocking; call off the main thread. */
    fun login(configuration: ServerConfiguration, body: LoginRequest): LoginResponse {
        val json = AppJson.encodeToString(LoginRequest.serializer(), body)
        val request = Request.Builder()
            .url(configuration.url("/api/v1/collectors/login"))
            .post(json.toRequestBody("application/json".toMediaType()))
            .build()
        val text = execute(loginClient, request)
        return try {
            AppJson.decodeFromString(LoginResponse.serializer(), text)
        } catch (e: Exception) {
            L.w("CollectorApi", "login response unreadable", e)
            throw ApiError.Unreadable()
        }
    }

    private fun execute(client: OkHttpClient, request: Request): String {
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful) {
                    val (code, message) = ApiError.parseErrorBody(text)
                    L.w("CollectorApi", "${request.url.encodedPath} HTTP ${response.code} code=$code")
                    throw ApiError.Http(response.code, code, message)
                }
                return text
            }
        } catch (e: ApiError) {
            throw e
        } catch (e: SocketTimeoutException) {
            throw ApiError.Timeout()
        } catch (e: InterruptedIOException) {
            throw ApiError.Timeout()
        } catch (e: IOException) {
            L.w("CollectorApi", "${request.url.encodedPath} connection failed: ${e.javaClass.simpleName}")
            throw ApiError.CannotConnect()
        }
    }
}
