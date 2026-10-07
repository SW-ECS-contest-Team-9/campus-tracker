package hoshi.campustracker.sync

import hoshi.campustracker.core.L
import hoshi.campustracker.model.LocationFix
import hoshi.campustracker.model.SensorCapabilities
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TelemetrySyncCoordinatorTest {
    private val owner = UploadOwner("C02", "http://h:3000")
    private val store = InMemoryUploadQueueStore()
    private val socket = FakeSocket()
    private var ids = 0

    @Before fun quietLogs() { L.sink = { _, _, _, _ -> } }

    private fun TestScope.sync(): TelemetrySyncCoordinator =
        TelemetrySyncCoordinator(store, socket, backgroundScope, nowMs = { 1_791_352_800_000L + testScheduler.currentTime }, newId = { "id-${++ids}" })
            .also { it.setOwner(owner); runCurrent() }

    private fun start(id: String) = SessionStartPayload(
        clientSessionId = id, deviceId = "dev", deviceModel = "m", systemVersion = "14", appVersion = "1.0",
        sensorCapabilities = SensorCapabilities(), startedAt = "2026-10-07T06:00:00.000Z",
    )

    private fun motion(seq: Long) = MotionPayload(seq, "2026-10-07T06:00:00.020Z", appState = "FOREGROUND", sensorSegmentId = "seg")

    private fun finish(id: String) = FinishPayload(id, endedAt = "2026-10-07T06:20:00.000Z", lastSequences = LastSequences(-1, 3, -1, -1))

    private fun TestScope.ackStart(serverId: String = "srv-1") {
        assertEquals("session:start", socket.last.type)
        socket.ackLast("""{"sessionId":"$serverId","clientSessionId":"x","resumed":false,"strideCalibration":{"status":"FALLBACK","reason":"MISSING"}}""")
        runCurrent()
    }

    @Test
    fun sendsOneRequestAtATimeInContractOrder() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        repeat(3) { sync.appendMotion(motion(it + 1L)) }
        runCurrent()
        advanceTimeBy(1_001) // batch timer
        sync.appendMarker(MarkerPayload("m1", clientSessionId = "A", timestamp = "t", type = "stop", latitude = 1.0, longitude = 2.0), needsLocation = false)
        sync.logDiagnostic("A", "SENSOR_STOPPED", mapOf("sensor" to "motion"), 0)
        sync.appendMotion(motion(4))
        sync.finish(finish("A"))
        runCurrent()
        assertEquals(0, socket.sent.size)
        assertEquals(5, sync.status.value.pending) // 2 batches + marker + finish + diagnostic

        socket.connect(); runCurrent()
        assertEquals(1, socket.requests.size)
        ackStart()
        val order = mutableListOf<String>()
        repeat(5) {
            assertEquals(it + 2, socket.requests.size) // never more than one outstanding
            val request = socket.last
            order += request.type
            if (request.type != "diagnostic:event") assertEquals("srv-1", request.payload.str("sessionId"))
            socket.ackLast("""{"duplicate":false}"""); runCurrent()
        }
        assertEquals(listOf("telemetry:batch", "telemetry:batch", "marker:create", "session:finish", "diagnostic:event"), order)
        assertEquals(0, sync.status.value.pending)
        assertNull(store.session("A")) // finished + empty → row removed
    }

    @Test
    fun ackTimeoutResendsTheSameBatchId() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        sync.appendMotion(motion(1)); runCurrent()
        advanceTimeBy(1_001)
        socket.connect(); runCurrent()
        ackStart()
        val first = socket.last
        assertEquals("telemetry:batch", first.type)
        advanceTimeBy(10_001) // no ACK
        assertEquals(socket.requests.size, socket.requests.indexOf(first) + 1)
        advanceTimeBy(2_001)
        val second = socket.last
        assertEquals("telemetry:batch", second.type)
        assertEquals(first.payload.str("batchId"), second.payload.str("batchId"))
        assertTrue(first["requestId"] != second["requestId"])
        // A late ACK for the old request is ignored; the item is still pending.
        socket.ack(first, ok = true); runCurrent()
        assertEquals(1, sync.status.value.pendingBatches)
    }

    @Test
    fun disconnectKeepsItemsAndReconnectRepeatsSessionStartWithSameId() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        socket.connect(); runCurrent()
        ackStart()
        sync.appendMotion(motion(1)); runCurrent()
        advanceTimeBy(1_001)
        assertEquals("telemetry:batch", socket.last.type)
        socket.drop(); runCurrent()
        assertEquals(1, sync.status.value.pendingBatches)
        socket.connect(); runCurrent()
        assertEquals("session:start", socket.last.type)
        assertEquals("A", socket.last.payload.str("clientSessionId"))
        assertEquals("2026-10-07T06:00:00.000Z", socket.last.payload.str("startedAt"))
        ackStart("srv-1")
        assertEquals("telemetry:batch", socket.last.type)
    }

    @Test
    fun retryableErrorRetriesAfterTwoSecondsAndNonRetryableIsQuarantined() = runTest {
        val sync = sync()
        sync.start(start("A"), owner, active = false)
        sync.appendMarker(MarkerPayload("m1", clientSessionId = "A", timestamp = "t", type = "stop", latitude = 1.0, longitude = 2.0), false)
        sync.appendMarker(MarkerPayload("m2", clientSessionId = "A", timestamp = "t", type = "stop", latitude = 1.0, longitude = 2.0), false)
        runCurrent()
        socket.connect(); runCurrent()
        ackStart()
        val m1 = socket.last
        socket.ack(m1, ok = false, error = """{"code":"INTERNAL","status":500,"retryable":true}"""); runCurrent()
        assertEquals(m1, socket.last)
        advanceTimeBy(2_001)
        assertEquals("m1", socket.last.payload.str("markerId"))
        socket.ack(socket.last, ok = false, error = """{"code":"VALIDATION_ERROR","status":400,"retryable":false,"details":{}}"""); runCurrent()
        assertEquals("m2", socket.last.payload.str("markerId")) // queue not blocked
        assertEquals(1, sync.status.value.quarantined)
        assertEquals("VALIDATION_ERROR", store.allItems().first { it.itemId == "m1" }.lastErrorCode)
    }

    @Test
    fun sessionNotFoundRestartsTheSessionOnceThenQuarantines() = runTest {
        val sync = sync()
        sync.start(start("A"), owner, active = false)
        sync.finish(finish("A"))
        runCurrent()
        socket.connect(); runCurrent()
        ackStart("srv-1")
        socket.ack(socket.last, ok = false, error = """{"code":"SESSION_NOT_FOUND","status":404,"retryable":false}"""); runCurrent()
        assertEquals("session:start", socket.last.type)
        ackStart("srv-2")
        assertEquals("session:finish", socket.last.type)
        assertEquals("srv-2", socket.last.payload.str("sessionId"))
        socket.ack(socket.last, ok = false, error = """{"code":"SESSION_NOT_FOUND","status":404,"retryable":false}"""); runCurrent()
        assertEquals(1, sync.status.value.quarantined)
    }

    @Test
    fun rejectedSessionStartHoldsOnlyThatSession() = runTest {
        val sync = sync()
        sync.start(start("A"), owner, active = false)
        sync.finish(finish("A"))
        sync.start(start("B"), owner, active = false)
        sync.finish(finish("B"))
        runCurrent()
        socket.connect(); runCurrent()
        assertEquals("A", socket.last.payload.str("clientSessionId"))
        socket.ack(socket.last, ok = false, error = """{"code":"SESSION_CONFLICT","status":409,"retryable":false}"""); runCurrent()
        assertEquals("B", socket.last.payload.str("clientSessionId"))
        ackStart("srv-b")
        assertEquals("session:finish", socket.last.type)
        assertEquals("B", socket.last.payload.str("clientSessionId"))
        socket.ackLast(); runCurrent()
        assertEquals(1, sync.status.value.pending) // A's finish stays queued
        // A new login retries A's session:start once more.
        sync.setOwner(owner); runCurrent()
        assertEquals("session:start", socket.last.type)
        assertEquals("A", socket.last.payload.str("clientSessionId"))
    }

    @Test
    fun itemsOfAnotherCollectorAreHeld() = runTest {
        val sync = sync()
        sync.start(start("A"), UploadOwner("C01", "http://h:3000"), active = false)
        sync.finish(finish("A"))
        runCurrent()
        socket.connect(); runCurrent()
        assertEquals(0, socket.sent.size)
        assertEquals(1, sync.status.value.heldForOtherOwner)
        sync.setOwner(UploadOwner("C01", "http://h:3000")); runCurrent()
        assertEquals("session:start", socket.last.type)
    }

    @Test
    fun markerWithoutLocationWaitsForTheFirstFix() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        sync.appendMarker(MarkerPayload("m1", clientSessionId = "A", timestamp = "2026-10-07T06:03:10.250Z", type = "entrance"), needsLocation = true)
        runCurrent()
        socket.connect(); runCurrent()
        ackStart()
        assertEquals(1, socket.requests.size) // nothing else sendable
        sync.fillMarkerLocations("A", LocationFix(37.61, 127.01, 82.4, 105.0, 4.8, 3.1)); runCurrent()
        val marker = socket.last
        assertEquals("marker:create", marker.type)
        assertEquals(37.61, marker.payload["latitude"]!!.jsonPrimitive.content.toDouble(), 0.0)
        assertEquals("2026-10-07T06:03:10.250Z", marker.payload.str("timestamp"))
    }

    @Test
    fun flushesImmediatelyAtSixtyFourSamples() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        repeat(64) { sync.appendMotion(motion(it + 1L)) }
        runCurrent()
        assertEquals(1, sync.status.value.pendingBatches)
        val batch = store.allItems().first { it.kind == ItemKind.batch }
        val motion = kotlinx.serialization.json.Json.parseToJsonElement(batch.payload).jsonObject["motion"]!!.jsonArray
        assertEquals(64, motion.size)
    }

    @Test
    fun statusIsSentAfterStartAckAndEverySevenSecondsWithoutQueueing() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        socket.connect(); runCurrent()
        ackStart()
        val statuses = { socket.sent.count { it.type == "collector:status" } }
        assertEquals(1, statuses())
        assertEquals("srv-1", socket.sent.last { it.type == "collector:status" }.payload.str("sessionId"))
        advanceTimeBy(7_001)
        assertEquals(2, statuses())
        assertEquals(0, sync.status.value.pending)
    }

    @Test
    fun startAckWithoutSessionIdIsRetriedAndUnknownAcksAreIgnored() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        socket.connect(); runCurrent()
        socket.deliver("""{"type":"ack","requestId":null,"ok":false,"error":{"code":"INVALID_JSON"}}""")
        socket.deliver("""{"type":"hello"}""")
        socket.deliver("not json")
        runCurrent()
        socket.ackLast("""{"clientSessionId":"A"}"""); runCurrent() // no data.sessionId
        assertEquals(1, socket.requests.size)
        advanceTimeBy(2_001)
        assertEquals(2, socket.requests.size)
        ackStart("srv-1")
        assertEquals("srv-1", store.session("A")!!.serverSessionId)
    }
}
