package hoshi.campustracker.collection

import hoshi.campustracker.core.L
import hoshi.campustracker.model.CollectorAppState
import hoshi.campustracker.model.DeviceInfo
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.MotionSamplingRate
import hoshi.campustracker.persistence.FileActiveCollectionStore
import hoshi.campustracker.persistence.LocalSensorDataRepository
import hoshi.campustracker.sync.FakeSocket
import hoshi.campustracker.sync.InMemoryUploadQueueStore
import hoshi.campustracker.sync.ItemKind
import hoshi.campustracker.sync.TelemetrySyncCoordinator
import hoshi.campustracker.sync.UploadOwner
import hoshi.campustracker.sync.payload
import hoshi.campustracker.sync.str
import hoshi.campustracker.sync.type
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class CollectionCoordinatorTest {
    @get:Rule val tmp = TemporaryFolder()
    private val owner = UploadOwner("C02", "http://h:3000")
    private val device = DeviceInfo("device-1", "samsung SM-S918N", "14", "1.0")
    private val queue = InMemoryUploadQueueStore() // survives a simulated process restart, like Room
    private var ids = 0

    @Before fun quietLogs() { L.sink = { _, _, _, _ -> } }

    private inner class Process(private val scope: TestScope, root: File) {
        val clock = FakeClock(1_791_352_800_000L + scope.testScheduler.currentTime)
        val executor = ManualExecutor(clock)
        val location = FakeLocation()
        val motion = FakeMotion()
        val altimeter = FakeAltimeter()
        val pedometer = FakePedometer()
        val platform = FakePlatform(motion, altimeter, pedometer)
        val socket = FakeSocket()
        val sync = TelemetrySyncCoordinator(queue, socket, scope.backgroundScope, { clock.now }, { "sync-${++ids}" }).also { it.setOwner(owner) }
        val coordinator = CollectionCoordinator(
            clock, executor, location, motion, altimeter, pedometer,
            LocalSensorDataRepository(root, { clock.now }), FileActiveCollectionStore(root), sync, platform, device,
            appState = { CollectorAppState.BACKGROUND }, newId = { "00000000-0000-0000-0000-${(++ids).toString().padStart(12, '0')}" },
        )

        /** Advances the collection executor and the upload side's virtual time together. */
        fun advance(ms: Long) {
            var left = ms
            while (left > 0) {
                val step = minOf(left, 20L)
                executor.advance(step)
                scope.testScheduler.advanceTimeBy(step)
                scope.testScheduler.runCurrent()
                left -= step
            }
        }
    }

    @Test
    fun offlineStartRestartResumeReconnectKeepsSessionIdentity() = runTest {
        val root = tmp.newFolder()
        val first = Process(this, root)
        first.coordinator.startSession("C02", owner, MotionSamplingRate.hz50, LocationCollectionProfile.highAccuracy, 0.0)
        first.executor.runAll()
        runCurrent()
        val session = first.coordinator.ui.value.activeSession!!
        assertTrue(first.platform.foreground)
        assertEquals("xTrueNorthZVertical", session.sensorCapabilities.attitudeReferenceFrame)
        for (i in 1..120) {
            first.motion.emit(first.clock.now)
            if (i % 50 == 0) first.location.emit(first.clock.now)
            first.advance(20)
        }
        first.coordinator.addMarker(EventMarkerType.stairStart)
        first.advance(1_500)
        runCurrent()
        // Process dies here (no Stop). Nothing was ever connected.
        assertTrue(File(root, "active_collection.json").exists())

        val second = Process(this, root)
        second.executor.runAll()
        val interrupted = second.coordinator.ui.value.interrupted
        assertNotNull(interrupted)
        assertEquals(session.id, interrupted!!.session.id)
        assertTrue(interrupted.diagnostics.wasInterrupted)
        val savedMotion = interrupted.motionSequence
        assertTrue(savedMotion in 100L..120L)

        second.coordinator.resumeInterrupted(owner)
        second.executor.runAll()
        runCurrent()
        assertEquals(session.id, second.coordinator.ui.value.activeSession!!.id)
        // Pedometer resumes with the saved baseline and boot count.
        assertEquals(1_000L, second.pedometer.restore!!.baseline)
        // Frame and declination fixed at the original start are reused.
        assertEquals(-8.7, second.motion.startedWith!!.declinationDeg!!, 0.0)
        second.motion.emit(second.clock.now)
        second.advance(1_100)
        runCurrent()

        second.socket.connect(); runCurrent()
        val start = second.socket.last
        assertEquals("session:start", start.type)
        assertEquals(session.id, start.payload.str("clientSessionId"))
        assertEquals(hoshi.campustracker.core.Iso.format(session.startedAt), start.payload.str("startedAt"))
        assertEquals("android", start.payload.str("platform"))
        second.socket.ackLast("""{"sessionId":"srv-1"}"""); runCurrent()

        // Walk the queue: sequences are contiguous before the crash; after the resume they continue at saved + 1000 + 1.
        val motionSequences = mutableListOf<Long>()
        while (second.socket.last.type == "telemetry:batch") {
            val request = second.socket.last
            request.payload["motion"]!!.jsonArray.forEach { motionSequences += it.jsonObject["sequence"]!!.jsonPrimitive.long }
            second.socket.ackLast(); runCurrent()
            if (second.socket.last == request) break
        }
        val beforeCrash = motionSequences.filter { it < 1_000 }
        assertEquals((1L..beforeCrash.size).toList(), beforeCrash)
        assertTrue(beforeCrash.size >= 100)
        assertEquals(listOf(savedMotion + 1_000 + 1), motionSequences.filter { it >= 1_000 })

        // Stop: an empty stream (no barometer, no steps) reports −1.
        second.coordinator.stopSession()
        second.executor.runAll()
        runCurrent()
        assertFalse(File(root, "active_collection.json").exists())
        assertFalse(second.platform.foreground)
        val finish = queue.allItems().first { it.kind == ItemKind.finish }
        val lastSequences = Json.parseToJsonElement(finish.payload).jsonObject["lastSequences"]!!.jsonObject
        assertEquals(-1L, lastSequences["altimeter"]!!.jsonPrimitive.long)
        assertEquals(-1L, lastSequences["pedometer"]!!.jsonPrimitive.long)
        assertEquals(savedMotion + 1_001, lastSequences["motion"]!!.jsonPrimitive.long)
        assertTrue(lastSequences["location"]!!.jsonPrimitive.long >= 2)
    }

    @Test
    fun finishAsInterruptedQueuesInterruptedFinish() = runTest {
        val root = tmp.newFolder()
        val first = Process(this, root)
        first.coordinator.startSession("C02", owner, MotionSamplingRate.hz50, LocationCollectionProfile.highAccuracy, 0.0)
        first.executor.runAll()
        first.motion.emit(first.clock.now)
        val lastSampleAt = first.clock.now
        first.advance(1_200)
        first.motion.emit(first.clock.now) // forces a persist ≥ 1 s after the start
        runCurrent()

        val second = Process(this, root)
        second.executor.runAll()
        second.coordinator.finishInterrupted(owner)
        second.executor.runAll()
        runCurrent()
        assertNull(second.coordinator.ui.value.interrupted)
        assertFalse(File(root, "active_collection.json").exists())
        val finish = Json.parseToJsonElement(queue.allItems().first { it.kind == ItemKind.finish }.payload).jsonObject
        assertEquals("true", finish["interrupted"]!!.jsonPrimitive.content)
        assertTrue(finish.str("endedAt")!! >= hoshi.campustracker.core.Iso.format(lastSampleAt))
        assertEquals(-1L, finish["lastSequences"]!!.jsonObject["location"]!!.jsonPrimitive.long)
    }

    @Test
    fun samplesCarryAppStateSegmentAndMarkersWithoutFixAreHeld() = runTest {
        val root = tmp.newFolder()
        val p = Process(this, root)
        p.coordinator.startSession("C02", owner, MotionSamplingRate.hz50, LocationCollectionProfile.highAccuracy, 0.0)
        p.executor.runAll()
        p.coordinator.addMarker(EventMarkerType.entrance)
        p.executor.runAll(); runCurrent()
        assertTrue(queue.allItems().first { it.kind == ItemKind.marker }.needsLocation)
        p.location.emit(p.clock.now)
        p.executor.runAll(); runCurrent()
        assertFalse(queue.allItems().first { it.kind == ItemKind.marker }.needsLocation)
        p.advance(1_100); runCurrent()
        val batch = Json.parseToJsonElement(queue.allItems().first { it.kind == ItemKind.batch }.payload).jsonObject
        val location = batch["locations"]!!.jsonArray.single().jsonObject
        assertEquals("BACKGROUND", location.str("appState"))
        assertNotNull(location.str("sensorSegmentId"))
        assertEquals(1L, location["sequence"]!!.jsonPrimitive.long)
        val events = queue.allItems().filter { it.kind == ItemKind.diagnostic }.map {
            Json.parseToJsonElement(it.payload).jsonObject["events"]!!.jsonArray.single().jsonObject
        }
        assertTrue(events.any { it.str("eventType") == "SENSOR_STARTED" && it["metadata"]!!.jsonObject.str("sensor") == "motion" })
        // Local NDJSON with millisecond timestamps.
        p.coordinator.stopSession(); p.executor.runAll()
        val lines = File(root, "sessions/${batch.str("clientSessionId")}/location.ndjson").readLines()
        assertEquals(1, lines.size)
        assertTrue(Regex("\"timestamp\":\"\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z\"").containsMatchIn(lines[0]))
    }
}
