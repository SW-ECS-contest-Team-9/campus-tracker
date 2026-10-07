package hoshi.campustracker.sync

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.core.Iso
import hoshi.campustracker.core.L
import hoshi.campustracker.model.LocationFix
import hoshi.campustracker.model.SampleCounts
import hoshi.campustracker.net.CollectorSocket
import hoshi.campustracker.net.CollectorSocketListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/** Who may upload a queued session: the collector and server it was recorded for (§12-6). */
data class UploadOwner(val collectorId: String, val serverKey: String)

data class UploadStatus(
    /** pending batch + marker + finish + diagnostic (session:start requests are not counted). */
    val pending: Int = 0,
    val pendingBatches: Int = 0,
    val quarantined: Int = 0,
    /** Pending items held because they belong to another collector or server. */
    val heldForOtherOwner: Int = 0,
)

/**
 * Upload side (iOS `TelemetrySyncCoordinator`): builds batches, keeps the persistent queue, and sends exactly one
 * request at a time over the raw WebSocket, deleting an item only after `ok: true` (§7). Every method hops onto
 * [scope], which must be single-threaded; all state below is confined to it.
 */
class TelemetrySyncCoordinator(
    private val store: UploadQueueStore,
    private val socket: CollectorSocket,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    companion object {
        private const val TAG = "UploadQueue"
        const val BATCH_INTERVAL_MS = 1_000L
        const val FLUSH_THRESHOLD = 64
        const val STATUS_INTERVAL_MS = 7_000L
        const val ACK_TIMEOUT_MS = 10_000L
        const val RETRY_DELAY_MS = 2_000L
        private val SESSION_RESTART_CODES = setOf("SESSION_NOT_FOUND", "SESSION_NOT_STARTED")
        private val ITEM_KINDS = listOf(ItemKind.batch, ItemKind.marker, ItemKind.finish, ItemKind.diagnostic)
    }

    /** Called on the sync thread when `session:start` is acknowledged. */
    var onServerSessionStarted: ((clientSessionId: String, serverSessionId: String) -> Unit)? = null

    private val _status = MutableStateFlow(UploadStatus())
    val status: StateFlow<UploadStatus> = _status

    private sealed class Request {
        data class Start(val clientSessionId: String) : Request()
        data class Item(val item: QueueItem) : Request()
    }

    private data class InFlight(val requestId: String, val request: Request, val timeout: Job)

    private var connected = false
    private var owner: UploadOwner? = null
    private var activeClientSessionId: String? = null
    private val blockedStarts = mutableSetOf<String>()
    private var inFlight: InFlight? = null
    private var backoff: Job? = null
    private var batchTimer: Job? = null
    private var statusTimer: Job? = null
    private var counts = SampleCounts()

    private val locations = ArrayList<LocationPayload>()
    private val motion = ArrayList<MotionPayload>()
    private val altimeter = ArrayList<AltimeterPayload>()
    private val pedometer = ArrayList<PedometerPayload>()

    init {
        socket.setListener(object : CollectorSocketListener {
            override fun onConnected() { scope.launch { handleConnected() } }
            override fun onDisconnected() { scope.launch { handleDisconnected() } }
            override fun onMessage(text: String) { scope.launch { handleMessage(text) } }
        })
        scope.launch {
            connected = socket.isConnected
            refreshStatus()
            pump()
        }
    }

    // ---- public API (any thread) ----

    fun setOwner(newOwner: UploadOwner?) = scope.launch {
        if (newOwner != null) blockedStarts.clear() // a fresh login retries a rejected session:start once more
        owner = newOwner
        refreshStatus()
        pump()
    }

    /**
     * Registers the session (idempotent: an existing row keeps its owner and server session ID) and, when [active],
     * starts the 1 s batch and 7 s status timers.
     */
    fun start(startPayload: SessionStartPayload, owner: UploadOwner, active: Boolean = true) = scope.launch {
        val json = encode(SessionStartPayload.serializer(), startPayload, "session:start", startPayload.clientSessionId) ?: return@launch
        store.insertSessionIfAbsent(QueueSession(startPayload.clientSessionId, owner.collectorId, owner.serverKey, json, null))
        if (active) {
            activeClientSessionId = startPayload.clientSessionId
            clearBuffers()
            // A resumed or newly started session handshakes again so the server treats it as this connection's session.
            store.setServerSessionId(startPayload.clientSessionId, null)
            startTimers()
        }
        refreshStatus()
        pump()
    }

    /** Flushes the remaining buffer as the last batch, then queues `session:finish` (§5.3/§7.1). */
    fun finish(payload: FinishPayload) = scope.launch {
        if (payload.clientSessionId == activeClientSessionId) {
            flushBatch()
            stopTimers()
            activeClientSessionId = null
        }
        val json = encode(FinishPayload.serializer(), payload, "session:finish", payload.clientSessionId) ?: return@launch
        store.insert(QueueItem(kind = ItemKind.finish, itemId = payload.clientSessionId, clientSessionId = payload.clientSessionId, payload = json))
        refreshStatus()
        pump()
    }

    fun appendLocation(sample: LocationPayload) = scope.launch { locations += sample; flushIfNeeded() }
    fun appendMotion(sample: MotionPayload) = scope.launch { motion += sample; flushIfNeeded() }
    fun appendAltimeter(sample: AltimeterPayload) = scope.launch { altimeter += sample; flushIfNeeded() }
    fun appendPedometer(sample: PedometerPayload) = scope.launch { pedometer += sample; flushIfNeeded() }

    /** [needsLocation]: no fix yet in this process; held until [fillMarkerLocations] (§12-5). */
    fun appendMarker(marker: MarkerPayload, needsLocation: Boolean) = scope.launch {
        val json = encode(MarkerPayload.serializer(), marker, "marker:create", marker.markerId) ?: return@launch
        store.insert(
            QueueItem(kind = ItemKind.marker, itemId = marker.markerId, clientSessionId = marker.clientSessionId, payload = json, needsLocation = needsLocation),
        )
        refreshStatus()
        pump()
    }

    fun fillMarkerLocations(clientSessionId: String, fix: LocationFix) = scope.launch {
        val waiting = store.pendingMarkersNeedingLocation(clientSessionId)
        if (waiting.isEmpty()) return@launch
        for (item in waiting) {
            val marker = runCatching { AppJson.decodeFromString(MarkerPayload.serializer(), item.payload) }.getOrNull() ?: continue
            val filled = marker.copy(
                latitude = fix.latitude, longitude = fix.longitude, altitude = fix.altitude,
                ellipsoidalAltitude = fix.ellipsoidalAltitude, horizontalAccuracy = fix.horizontalAccuracy, verticalAccuracy = fix.verticalAccuracy,
            )
            val json = encode(MarkerPayload.serializer(), filled, "marker:create", marker.markerId) ?: continue
            store.update(item.copy(payload = json, needsLocation = false))
            L.i(TAG, "marker location filled markerId=${marker.markerId}")
        }
        pump()
    }

    fun logDiagnostic(clientSessionId: String, eventType: String, metadata: Map<String, String>, timestampMs: Long) = scope.launch {
        val eventId = newId()
        val payload = DiagnosticEventPayload(clientSessionId, listOf(DiagnosticEventItem(eventId, eventType, Iso.format(timestampMs), metadata)))
        val json = encode(DiagnosticEventPayload.serializer(), payload, "diagnostic:event", eventId) ?: return@launch
        store.insert(QueueItem(kind = ItemKind.diagnostic, itemId = eventId, clientSessionId = clientSessionId, payload = json))
        refreshStatus()
        pump()
    }

    fun updateCounts(sampleCounts: SampleCounts) = scope.launch { counts = sampleCounts }

    // ---- batches ----

    private fun flushIfNeeded() {
        if (locations.size + motion.size + altimeter.size + pedometer.size >= FLUSH_THRESHOLD) flushBatch()
    }

    private fun flushBatch() {
        val sessionId = activeClientSessionId
        if (locations.isEmpty() && motion.isEmpty() && altimeter.isEmpty() && pedometer.isEmpty()) return
        if (sessionId == null) {
            L.w(TAG, "dropping buffered samples without an active session")
            clearBuffers()
            return
        }
        val batch = TelemetryBatchPayload(
            batchId = newId(), clientSessionId = sessionId, createdAt = Iso.format(nowMs()),
            locations = locations.toList(), motion = motion.toList(), altimeter = altimeter.toList(), pedometer = pedometer.toList(),
        )
        clearBuffers()
        val json = encode(TelemetryBatchPayload.serializer(), batch, "telemetry:batch", batch.batchId) ?: return
        store.insert(QueueItem(kind = ItemKind.batch, itemId = batch.batchId, clientSessionId = sessionId, payload = json))
        refreshStatus()
        pump()
    }

    private fun clearBuffers() {
        locations.clear(); motion.clear(); altimeter.clear(); pedometer.clear()
    }

    private fun startTimers() {
        stopTimers()
        batchTimer = scope.launch {
            while (isActive) {
                delay(BATCH_INTERVAL_MS)
                flushBatch()
            }
        }
        statusTimer = scope.launch {
            while (isActive) {
                delay(STATUS_INTERVAL_MS)
                sendStatus()
            }
        }
    }

    private fun stopTimers() {
        batchTimer?.cancel(); batchTimer = null
        statusTimer?.cancel(); statusTimer = null
    }

    // ---- connection ----

    private fun handleConnected() {
        connected = true
        backoff?.cancel(); backoff = null
        // Every new connection repeats session:start with the same clientSessionId so the server restores
        // (rather than replaces) the active session (§7.3).
        activeClientSessionId?.let {
            store.setServerSessionId(it, null)
            L.i(TAG, "reconnect handshake required clientSessionId=$it")
        }
        pump()
    }

    private fun handleDisconnected() {
        connected = false
        inFlight?.let {
            it.timeout.cancel()
            L.i(TAG, "connection lost with request in flight requestId=${it.requestId}; item stays queued")
        }
        inFlight = null
    }

    // ---- sending ----

    private fun pump() {
        if (inFlight != null || !connected || backoff != null) return
        val currentOwner = owner ?: return
        val eligible = store.sessions().filter {
            it.collectorId == currentOwner.collectorId && it.serverKey == currentOwner.serverKey && it.clientSessionId !in blockedStarts
        }
        if (eligible.isEmpty()) return
        // 1. session:start for every eligible session without a server session ID (keeps the oldest-first order:
        //    nothing later is sent while an earlier session still waits for its ID).
        eligible.firstOrNull { it.serverSessionId == null }?.let {
            sendStart(it)
            return
        }
        val byId = eligible.associateBy { it.clientSessionId }
        // 2-5. oldest batch, marker, finish, diagnostic.
        for (kind in ITEM_KINDS) {
            val item = store.oldestPending(kind, byId.keys).firstOrNull { !it.needsLocation } ?: continue
            sendItem(item, byId.getValue(item.clientSessionId))
            return
        }
    }

    private fun sendStart(session: QueueSession) {
        val payload = runCatching { AppJson.parseToJsonElement(session.startPayload).jsonObject }.getOrElse {
            L.e(TAG, "stored session:start unreadable clientSessionId=${session.clientSessionId}", it)
            blockedStarts += session.clientSessionId
            return
        }
        dispatch("session:start", payload, Request.Start(session.clientSessionId), session.clientSessionId)
    }

    private fun sendItem(item: QueueItem, session: QueueSession) {
        val parsed = runCatching { AppJson.parseToJsonElement(item.payload).jsonObject }.getOrElse {
            L.e(TAG, "stored ${item.kind} unreadable item=${item.itemId}", it)
            store.update(item.copy(state = ItemState.QUARANTINED, lastErrorCode = "UNREADABLE_PAYLOAD"))
            refreshStatus()
            pump()
            return
        }
        val payload = if (item.kind == ItemKind.diagnostic) parsed else {
            JsonObject(parsed + ("sessionId" to JsonPrimitive(session.serverSessionId)))
        }
        dispatch(item.kind.wireType, payload, Request.Item(item), item.itemId)
    }

    private fun dispatch(type: String, payload: JsonObject, request: Request, itemId: String) {
        val requestId = newId()
        val text = buildJsonObject {
            put("requestId", JsonPrimitive(requestId))
            put("type", JsonPrimitive(type))
            put("payload", payload)
        }.toString()
        val timeout = scope.launch {
            delay(ACK_TIMEOUT_MS)
            if (inFlight?.requestId == requestId) {
                L.w(TAG, "ACK timeout type=$type requestId=$requestId item=$itemId; will resend with the same ID")
                inFlight = null
                scheduleRetry()
            }
        }
        inFlight = InFlight(requestId, request, timeout)
        L.d(TAG, "send type=$type requestId=$requestId item=$itemId bytes=${text.length}")
        if (!socket.send(text)) {
            L.w(TAG, "send failed type=$type requestId=$requestId item=$itemId")
            timeout.cancel()
            inFlight = null
            scheduleRetry()
        }
    }

    private fun scheduleRetry() {
        if (backoff != null) return
        backoff = scope.launch {
            delay(RETRY_DELAY_MS)
            backoff = null
            pump()
        }
    }

    private fun sendStatus() {
        if (!connected) return
        val id = activeClientSessionId ?: return
        val serverId = store.session(id)?.serverSessionId ?: return
        val payload = CollectorStatusPayload(
            sessionId = serverId, collecting = true,
            locationSampleCount = counts.location, motionSampleCount = counts.motion,
            pendingBatchCount = store.countPending(listOf(ItemKind.batch)),
        )
        val text = buildJsonObject {
            put("requestId", JsonPrimitive(newId()))
            put("type", JsonPrimitive("collector:status"))
            put("payload", AppJson.encodeToJsonElement(CollectorStatusPayload.serializer(), payload))
        }.toString()
        socket.send(text) // fire-and-forget: its ACK is ignored
    }

    // ---- ACKs ----

    private fun handleMessage(text: String) {
        val obj = runCatching { AppJson.parseToJsonElement(text).jsonObject }.getOrNull()
        if (obj == null || obj["type"]?.jsonPrimitive?.contentOrNull != "ack") {
            L.d(TAG, "ignored non-ACK message bytes=${text.length}")
            return
        }
        val requestId = (obj["requestId"] as? JsonPrimitive)?.contentOrNull
        val ok = (obj["ok"] as? JsonPrimitive)?.booleanOrNull == true
        val error = (obj["error"] as? JsonObject)?.let { runCatching { AppJson.decodeFromJsonElement<AckError>(it) }.getOrNull() }
        val data = obj["data"] as? JsonObject
        if (requestId == null) {
            L.w(TAG, "ACK without requestId code=${error?.code}")
            return
        }
        val current = inFlight
        if (current == null || current.requestId != requestId) {
            L.d(TAG, "ACK for a request not in flight requestId=$requestId ok=$ok")
            return
        }
        current.timeout.cancel()
        inFlight = null
        val duplicate = (data?.get("duplicate") as? JsonPrimitive)?.booleanOrNull
        L.d(TAG, "ACK requestId=$requestId ok=$ok duplicate=$duplicate code=${error?.code} retryable=${error?.retryable}")
        when (val request = current.request) {
            is Request.Start -> handleStartAck(request.clientSessionId, ok, data, error)
            is Request.Item -> handleItemAck(request.item, ok, error)
        }
    }

    private fun handleStartAck(clientSessionId: String, ok: Boolean, data: JsonObject?, error: AckError?) {
        if (ok) {
            val ack = data?.let { runCatching { AppJson.decodeFromJsonElement<SessionStartAckData>(it) }.getOrNull() }
            val serverId = ack?.sessionId
            if (serverId.isNullOrBlank()) {
                L.w(TAG, "session:start ACK without data.sessionId clientSessionId=$clientSessionId")
                scheduleRetry()
                return
            }
            store.setServerSessionId(clientSessionId, serverId)
            L.i(TAG, "session:start ACK serverSessionId=$serverId stride=${ack.strideCalibration?.status}/${ack.strideCalibration?.reason}")
            onServerSessionStarted?.invoke(clientSessionId, serverId)
            if (clientSessionId == activeClientSessionId) sendStatus()
            pump()
            return
        }
        if (isRetryable(error)) {
            scheduleRetry()
        } else {
            // Hold this session's items; other sessions keep uploading. Retried after a new login or app restart.
            L.w(TAG, "session:start rejected code=${error?.code}; holding clientSessionId=$clientSessionId")
            blockedStarts += clientSessionId
            refreshStatus()
            pump()
        }
    }

    private fun handleItemAck(item: QueueItem, ok: Boolean, error: AckError?) {
        if (ok) {
            store.delete(item.seq)
            if (item.kind == ItemKind.finish) store.setFinishAcked(item.clientSessionId)
            cleanupSession(item.clientSessionId)
            refreshStatus()
            pump()
            return
        }
        val code = error?.code
        if (code in SESSION_RESTART_CODES) {
            if (!item.sessionRetried) {
                L.w(TAG, "$code for item=${item.itemId}; re-sending session:start then retrying once")
                store.update(item.copy(sessionRetried = true, lastErrorCode = code))
                store.setServerSessionId(item.clientSessionId, null)
                pump()
            } else {
                quarantine(item, code)
            }
            return
        }
        if (isRetryable(error)) {
            store.update(item.copy(lastErrorCode = code))
            scheduleRetry()
        } else {
            quarantine(item, code)
        }
    }

    private fun quarantine(item: QueueItem, code: String?) {
        L.w(TAG, "quarantined ${item.kind} item=${item.itemId} code=$code")
        store.update(item.copy(state = ItemState.QUARANTINED, lastErrorCode = code ?: "UNKNOWN"))
        refreshStatus()
        pump()
    }

    private fun isRetryable(error: AckError?): Boolean = error?.retryable ?: ((error?.status ?: 500) >= 500)

    private fun cleanupSession(clientSessionId: String) {
        if (clientSessionId == activeClientSessionId) return
        val session = store.session(clientSessionId) ?: return
        if (session.finishAcked && store.countItems(clientSessionId) == 0) store.deleteSession(clientSessionId)
    }

    // ---- helpers ----

    private fun refreshStatus() {
        val currentOwner = owner
        val foreign = store.sessions().filter { currentOwner == null || it.collectorId != currentOwner.collectorId || it.serverKey != currentOwner.serverKey }
        _status.value = UploadStatus(
            pending = store.countPending(ITEM_KINDS),
            pendingBatches = store.countPending(listOf(ItemKind.batch)),
            quarantined = store.countQuarantined(),
            heldForOtherOwner = store.countPendingInSessions(foreign.map { it.clientSessionId }),
        )
    }

    private fun <T> encode(serializer: kotlinx.serialization.KSerializer<T>, value: T, type: String, itemId: String): String? =
        try {
            AppJson.encodeToString(serializer, value)
        } catch (e: SerializationException) {
            L.e(TAG, "JSON encode failed type=$type item=$itemId", e)
            null
        } catch (e: IllegalArgumentException) {
            L.e(TAG, "JSON encode failed type=$type item=$itemId", e)
            null
        }
}
