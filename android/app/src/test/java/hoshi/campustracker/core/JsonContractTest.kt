package hoshi.campustracker.core

import hoshi.campustracker.model.CollectionSession
import hoshi.campustracker.model.SensorCapabilities
import hoshi.campustracker.persistence.ActiveCollectionState
import hoshi.campustracker.sensors.MotionMath
import hoshi.campustracker.sync.AttitudePayload
import hoshi.campustracker.sync.DiagnosticEventItem
import hoshi.campustracker.sync.DiagnosticEventPayload
import hoshi.campustracker.sync.FinishPayload
import hoshi.campustracker.sync.LastSequences
import hoshi.campustracker.sync.LocationPayload
import hoshi.campustracker.sync.MarkerPayload
import hoshi.campustracker.sync.MotionPayload
import hoshi.campustracker.sync.PedometerPayload
import hoshi.campustracker.sync.SessionStartAckData
import hoshi.campustracker.sync.SessionStartPayload
import hoshi.campustracker.sync.TelemetryBatchPayload
import hoshi.campustracker.sync.Vec3
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonContractTest {
    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    @Test
    fun timestampsAreUtcWithExactlyThreeFractionDigits() {
        assertEquals("2026-10-07T06:00:00.123Z", Iso.format(1_791_352_800_123L))
        assertEquals("2026-10-07T06:00:00.000Z", Iso.format(1_791_352_800_000L))
        assertEquals(1_791_352_800_123L, Iso.parse("2026-10-07T06:00:00.123Z"))
    }

    @Test
    fun nanBecomesNullAndNullsAreOmitted() {
        val motion = MotionPayload(
            sequence = 600, timestamp = "2026-10-07T06:00:00.420Z",
            userAcceleration = MotionMath.toCoreMotionG(floatArrayOf(Float.NaN, 0f, 0f)),
            rotationRate = null, gravity = null, attitude = AttitudePayload(Double.NaN.finiteOrNull(), 1.04, -1.92),
            appState = "FOREGROUND", sensorSegmentId = "seg",
        )
        val text = AppJson.encodeToString(MotionPayload.serializer(), motion)
        assertFalse(text.contains("NaN"))
        assertFalse(text.contains("null"))
        assertEquals(
            json("""{"sequence":600,"timestamp":"2026-10-07T06:00:00.420Z","userAcceleration":{"y":-0.0,"z":-0.0},"attitude":{"pitch":1.04,"yaw":-1.92},"appState":"FOREGROUND","sensorSegmentId":"seg"}"""),
            json(text),
        )
    }

    @Test
    fun integerFieldsAreJsonIntegers() {
        val p = PedometerPayload(5, "2026-10-07T06:00:00.180Z", "LIVE", 42, "FOREGROUND", "seg")
        val text = AppJson.encodeToString(PedometerPayload.serializer(), p)
        assertTrue(text.contains("\"sequence\":5,"))
        assertTrue(text.contains("\"numberOfSteps\":42,"))
        assertEquals(
            json("""{"sequence":5,"timestamp":"2026-10-07T06:00:00.180Z","captureSource":"LIVE","numberOfSteps":42,"appState":"FOREGROUND","sensorSegmentId":"seg"}"""),
            json(text),
        )
    }

    @Test
    fun batchMatchesContract() {
        val batch = TelemetryBatchPayload(
            batchId = "b", clientSessionId = "c", createdAt = "2026-10-07T06:00:01.000Z",
            locations = listOf(
                LocationPayload(
                    12, "2026-10-07T06:00:00.412Z", 37.6105, 127.0102, 82.4, 105.0, 4.8, 3.1, 1.3, 271.0, 0.4, 12.0, "FOREGROUND", "s1",
                ),
            ),
            motion = listOf(MotionPayload(600, "2026-10-07T06:00:00.420Z", Vec3(0.012, -0.031, 0.094), Vec3(0.1, -0.02, 0.31), Vec3(0.05, -0.86, -0.5), AttitudePayload(0.1, 1.04, -1.92), "FOREGROUND", "s2")),
        )
        val expected = """
            {"batchId":"b","clientSessionId":"c","createdAt":"2026-10-07T06:00:01.000Z",
             "locations":[{"sequence":12,"timestamp":"2026-10-07T06:00:00.412Z","latitude":37.6105,"longitude":127.0102,
               "altitude":82.4,"ellipsoidalAltitude":105.0,"horizontalAccuracy":4.8,"verticalAccuracy":3.1,"speed":1.3,"course":271.0,
               "speedAccuracy":0.4,"courseAccuracy":12.0,"appState":"FOREGROUND","sensorSegmentId":"s1"}],
             "motion":[{"sequence":600,"timestamp":"2026-10-07T06:00:00.420Z","userAcceleration":{"x":0.012,"y":-0.031,"z":0.094},
               "rotationRate":{"x":0.1,"y":-0.02,"z":0.31},"gravity":{"x":0.05,"y":-0.86,"z":-0.5},
               "attitude":{"roll":0.1,"pitch":1.04,"yaw":-1.92},"appState":"FOREGROUND","sensorSegmentId":"s2"}],
             "altimeter":[],"pedometer":[]}
        """
        assertEquals(json(expected), json(AppJson.encodeToString(TelemetryBatchPayload.serializer(), batch)))
    }

    @Test
    fun sessionStartSendsAndroidPlatformAndNoStrideCalibration() {
        val start = SessionStartPayload(
            clientSessionId = "c", deviceId = "d", deviceModel = "samsung SM-S918N", systemVersion = "14", appVersion = "1.0",
            sensorCapabilities = SensorCapabilities(locationAvailable = true, motionUpdateHz = 50, motionConvention = SensorCapabilities.MOTION_CONVENTION),
            startedAt = "2026-10-07T06:00:00.000Z",
        )
        val obj = json(AppJson.encodeToString(SessionStartPayload.serializer(), start)).toString()
        assertTrue(obj.contains("\"platform\":\"android\""))
        assertFalse(obj.contains("strideCalibration"))
        assertTrue(obj.contains("\"motionConvention\":\"COREMOTION_G_V1\""))
        assertFalse(obj.contains("magneticDeclinationDeg")) // null → omitted
    }

    @Test
    fun finishMarkerAndDiagnosticMatchContract() {
        val finish = FinishPayload("c", endedAt = "2026-10-07T06:20:00.000Z", lastSequences = LastSequences(1180, 60012, -1, -1), interrupted = true)
        assertEquals(
            json("""{"clientSessionId":"c","endedAt":"2026-10-07T06:20:00.000Z","lastSequences":{"location":1180,"motion":60012,"altimeter":-1,"pedometer":-1},"interrupted":true}"""),
            json(AppJson.encodeToString(FinishPayload.serializer(), finish)),
        )
        val marker = MarkerPayload("m", clientSessionId = "c", timestamp = "2026-10-07T06:03:10.250Z", type = "stairStart", latitude = 37.6105, longitude = 127.0102)
        assertEquals(
            json("""{"markerId":"m","clientSessionId":"c","timestamp":"2026-10-07T06:03:10.250Z","type":"stairStart","latitude":37.6105,"longitude":127.0102}"""),
            json(AppJson.encodeToString(MarkerPayload.serializer(), marker)),
        )
        val diag = DiagnosticEventPayload("c", listOf(DiagnosticEventItem("e", "SENSOR_STARTED", "2026-10-07T06:00:00.050Z", mapOf("sensor" to "motion"))))
        assertEquals(
            json("""{"clientSessionId":"c","events":[{"eventId":"e","eventType":"SENSOR_STARTED","clientTimestamp":"2026-10-07T06:00:00.050Z","metadata":{"sensor":"motion"}}]}"""),
            json(AppJson.encodeToString(DiagnosticEventPayload.serializer(), diag)),
        )
    }

    @Test
    fun ackDataWithUnknownFieldsAndUnknownStrideValuesDecodes() {
        val data = AppJson.decodeFromString(
            SessionStartAckData.serializer(),
            """{"sessionId":"s","clientSessionId":"c","resumed":true,"future":{"x":1},"strideCalibration":{"status":"SOMETHING_NEW","reason":"WHO_KNOWS","extra":2}}""",
        )
        assertEquals("s", data.sessionId)
        assertEquals("SOMETHING_NEW", data.strideCalibration?.status)
        assertNull(AppJson.decodeFromString(SessionStartAckData.serializer(), """{"sessionId":"s"}""").strideCalibration)
    }

    @Test
    fun oldPersistedJsonWithoutNewFieldsStillDecodes() {
        val oldSession = """{"id":"c","collectorId":"C02","deviceId":"d","startedAt":"2026-10-07T06:00:00.000Z","status":"recording",
            "sensorCapabilities":{"locationAvailable":true},"sampleCounts":{"location":3}}"""
        val s = AppJson.decodeFromString(CollectionSession.serializer(), oldSession)
        assertEquals(3, s.sampleCounts.location)
        assertNull(s.strideCalibration)
        val oldState = """{"session":$oldSession,"motionSequence":12,"unknownFutureKey":true}"""
        val state = AppJson.decodeFromString(ActiveCollectionState.serializer(), oldState)
        assertEquals(12L, state.motionSequence)
        assertNull(state.stepBaseline)
        assertEquals(0, state.diagnostics.motionGaps.count)
    }
}
