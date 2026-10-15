package hoshi.campustracker.sync

import hoshi.campustracker.collection.BeaconCollectionPolicy
import hoshi.campustracker.core.L
import hoshi.campustracker.model.SensorCapabilities
import hoshi.campustracker.positioning.BeaconConfig
import hoshi.campustracker.positioning.BeaconFeatures
import hoshi.campustracker.positioning.CacheFreshness
import hoshi.campustracker.positioning.CachedBeaconConfig
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BeaconUploadTest {
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

    private fun beacon(n: Int) = BeaconObservationPayload(observationId = "o$n", uuid = "e2c56db5-dffb-48d2-b060-d0f5a71096e0", major = 1, minor = 2,
        rssiDbm = -70, observedAt = "2026-10-07T06:00:0$n.000Z", rssiAggregation = "SINGLE_ADVERTISEMENT", sampleCount = 1)

    private fun TestScope.ackStart(features: String) {
        assertEquals("session:start", socket.last.type)
        socket.ackLast("""{"sessionId":"srv-1","resumed":false,"supportedTelemetryFeatures":$features}""")
        runCurrent()
    }

    @Test
    fun beaconBatchesWaitForTheServerFeatureAndCarryTheServerSessionId() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        sync.appendBeacon(beacon(1)); sync.appendBeacon(beacon(2))
        runCurrent()
        advanceTimeBy(1_001) // the 1 s batch timer flushes beacons too
        assertEquals(1, sync.pendingBeaconBatches())
        assertEquals(0, sync.status.value.pending) // optional data is not "pending telemetry"
        socket.connect(); runCurrent()
        ackStart("""["absoluteAltitudeV1","beaconObservationsV1"]""")
        val request = socket.last
        assertEquals("beacon.observations.v1", request.type)
        assertEquals("srv-1", request.payload.str("sessionId"))
        assertEquals(1, request.payload["schemaVersion"]!!.jsonPrimitive.content.toInt())
        assertEquals(2, request.payload["observations"]!!.jsonArray.size)
        assertEquals("android", request.payload.str("platform"))
        socket.ackLast("""{"duplicate":false,"inserted":2}"""); runCurrent()
        assertEquals(0, sync.pendingBeaconBatches())
    }

    @Test
    fun olderServerWithoutTheFeatureNeverReceivesBeaconsAndTelemetryFlowsOn() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        sync.appendBeacon(beacon(1))
        sync.appendMotion(MotionPayload(1, "2026-10-07T06:00:00.020Z", appState = "FOREGROUND", sensorSegmentId = "seg"))
        runCurrent()
        advanceTimeBy(1_001)
        socket.connect(); runCurrent()
        ackStart("""["absoluteAltitudeV1"]""")
        assertEquals("telemetry:batch", socket.last.type)
        socket.ackLast(); runCurrent()
        // no beacon request; the single re-handshake for the unknown feature is not repeated
        assertFalse(socket.requests.drop(2).any { it.type == "beacon.observations.v1" })
        assertEquals(1, sync.pendingBeaconBatches()) // kept on the phone, not dropped or quarantined
        assertEquals(0, store.countQuarantined())
    }

    @Test
    fun serverTurningBeaconsOffHoldsTheRowsWithoutQuarantine() = runTest {
        val sync = sync()
        sync.start(start("A"), owner)
        sync.appendBeacon(beacon(1))
        runCurrent(); advanceTimeBy(1_001)
        socket.connect(); runCurrent()
        ackStart("""["beaconObservationsV1"]""")
        socket.ack(socket.last, ok = false, error = """{"code":"BEACON_DISABLED","status":503,"retryable":false}"""); runCurrent()
        assertEquals(1, sync.pendingBeaconBatches())
        assertEquals(0, store.countQuarantined())
    }

    @Test
    fun localUploadSwitchKeepsBatchesQueued() = runTest {
        val sync = sync()
        sync.beaconUploadEnabled = false
        sync.start(start("A"), owner)
        sync.appendBeacon(beacon(1))
        runCurrent(); advanceTimeBy(1_001)
        socket.connect(); runCurrent()
        ackStart("""["beaconObservationsV1"]""")
        assertTrue(socket.requests.none { it.type == "beacon.observations.v1" })
        sync.beaconUploadEnabled = true
        sync.setOwner(owner); runCurrent()
        assertEquals("beacon.observations.v1", socket.last.type)
    }

    @Test
    fun collectionPolicy() {
        val config = BeaconConfig(schemaVersion = 1, configVersion = 3, features = BeaconFeatures(scanning = true, upload = true),
            proximityUuids = listOf("E2C56DB5-DFFB-48D2-B060-D0F5A71096E0"))
        val cached = CachedBeaconConfig(config, "e", 0, "srv")
        assertEquals("NO_ACTIVE_SESSION", BeaconCollectionPolicy.decide(false, true, true, cached, CacheFreshness.FRESH).reason)
        assertEquals("LOCAL_SWITCH_OFF", BeaconCollectionPolicy.decide(true, false, true, cached, CacheFreshness.FRESH).reason)
        assertEquals("NO_CONFIG", BeaconCollectionPolicy.decide(true, true, true, null, CacheFreshness.MISSING).reason)
        val ok = BeaconCollectionPolicy.decide(true, true, true, cached, CacheFreshness.STALE_USABLE)
        assertTrue(ok.scan && ok.upload && ok.uuids == setOf("e2c56db5-dffb-48d2-b060-d0f5a71096e0"))
        val remoteOff = cached.copy(config = config.copy(features = BeaconFeatures(scanning = false)))
        assertEquals("SERVER_SWITCH_OFF", BeaconCollectionPolicy.decide(true, true, true, remoteOff, CacheFreshness.FRESH).reason)
        assertFalse(BeaconCollectionPolicy.decide(true, true, false, cached, CacheFreshness.FRESH).upload)
        assertEquals("NO_REGISTERED_BEACONS", BeaconCollectionPolicy.decide(true, true, true, cached.copy(config = config.copy(proximityUuids = emptyList())), CacheFreshness.FRESH).reason)
        assertEquals("EXPIRED_CONFIG", BeaconCollectionPolicy.decide(true, true, true, remoteOff, CacheFreshness.EXPIRED).reason)
    }
}
