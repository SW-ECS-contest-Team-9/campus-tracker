package hoshi.campustracker.sync

import hoshi.campustracker.net.CollectorSocket
import hoshi.campustracker.net.CollectorSocketListener
import hoshi.campustracker.net.ConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class FakeSocket : CollectorSocket {
    override val state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    private var listener: CollectorSocketListener? = null
    val sent = mutableListOf<JsonObject>()

    override fun send(text: String): Boolean {
        if (state.value != ConnectionState.Connected) return false
        sent += Json.parseToJsonElement(text).jsonObject
        return true
    }

    override fun setListener(listener: CollectorSocketListener) {
        this.listener = listener
    }

    fun connect() {
        state.value = ConnectionState.Connected
        listener!!.onConnected()
    }

    fun drop() {
        state.value = ConnectionState.Reconnecting
        listener!!.onDisconnected()
    }

    fun deliver(text: String) = listener!!.onMessage(text)

    /** Requests that expect an ACK (everything except collector:status). */
    val requests: List<JsonObject> get() = sent.filter { it.type != "collector:status" }
    val last: JsonObject get() = requests.last()

    fun ackLast(data: String = "{}") = ack(last, ok = true, data = data)

    fun ack(request: JsonObject, ok: Boolean, data: String = "{}", error: String? = null) {
        val id = request["requestId"]!!.jsonPrimitive.content
        val body = if (ok) """{"type":"ack","requestId":"$id","ok":true,"data":$data}"""
        else """{"type":"ack","requestId":"$id","ok":false,"error":$error}"""
        deliver(body)
    }
}

val JsonObject.type: String get() = this["type"]!!.jsonPrimitive.content
val JsonObject.payload: JsonObject get() = this["payload"]!!.jsonObject
fun JsonObject.str(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
