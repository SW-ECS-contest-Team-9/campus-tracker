package hoshi.campustracker.net

import kotlinx.coroutines.flow.StateFlow

sealed class ConnectionState(val label: String) {
    data object Disconnected : ConnectionState("Disconnected")
    data object Connecting : ConnectionState("Connecting…")
    data object Connected : ConnectionState("Connected")
    data object Reconnecting : ConnectionState("Reconnecting…")
    data class Failed(val message: String) : ConnectionState("Connection failed")
}

/** Socket events, delivered for every connection (not conflated like a StateFlow). */
interface CollectorSocketListener {
    fun onConnected()
    fun onDisconnected()
    fun onMessage(text: String)
}

/** The raw `/ws/collector` connection as the upload side sees it. */
interface CollectorSocket {
    val state: StateFlow<ConnectionState>
    val isConnected: Boolean get() = state.value == ConnectionState.Connected
    /** Queues a text frame; false when there is no open connection. */
    fun send(text: String): Boolean
    fun setListener(listener: CollectorSocketListener)
}
