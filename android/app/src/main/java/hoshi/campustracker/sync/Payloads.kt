package hoshi.campustracker.sync

import hoshi.campustracker.model.SensorCapabilities
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Wire DTOs (§3.4). Timestamps are pre-formatted ISO-8601 ms strings; every Double is already finite or null.

@Serializable
data class Vec3(val x: Double?, val y: Double?, val z: Double?)

@Serializable
data class AttitudePayload(val roll: Double?, val pitch: Double?, val yaw: Double?)

@Serializable
data class LocationPayload(
    val sequence: Long,
    val timestamp: String,
    val latitude: Double,
    val longitude: Double,
    val altitude: Double? = null,
    val ellipsoidalAltitude: Double? = null,
    val horizontalAccuracy: Double? = null,
    val verticalAccuracy: Double? = null,
    val speed: Double? = null,
    val course: Double? = null,
    val speedAccuracy: Double? = null,
    val courseAccuracy: Double? = null,
    val appState: String,
    val sensorSegmentId: String,
)

@Serializable
data class MotionPayload(
    val sequence: Long,
    val timestamp: String,
    val userAcceleration: Vec3? = null,
    val rotationRate: Vec3? = null,
    val gravity: Vec3? = null,
    val attitude: AttitudePayload? = null,
    val appState: String,
    val sensorSegmentId: String,
)

@Serializable
data class AltimeterPayload(
    val sequence: Long,
    val timestamp: String,
    val relativeAltitude: Double?,
    val pressure: Double?,
    val appState: String,
    val sensorSegmentId: String,
)

@Serializable
data class PedometerPayload(
    val sequence: Long,
    val timestamp: String,
    val captureSource: String,
    val numberOfSteps: Long,
    val appState: String,
    val sensorSegmentId: String,
)

@Serializable
data class TelemetryBatchPayload(
    val batchId: String,
    val sessionId: String? = null,
    val clientSessionId: String,
    val createdAt: String,
    val locations: List<LocationPayload> = emptyList(),
    val motion: List<MotionPayload> = emptyList(),
    val altimeter: List<AltimeterPayload> = emptyList(),
    val pedometer: List<PedometerPayload> = emptyList(),
)

@Serializable
data class MarkerPayload(
    val markerId: String,
    val sessionId: String? = null,
    val clientSessionId: String,
    val timestamp: String,
    val type: String,
    // Nullable only while queued: a marker without a fix is held until one arrives (§12-5).
    val latitude: Double? = null,
    val longitude: Double? = null,
    val altitude: Double? = null,
    val ellipsoidalAltitude: Double? = null,
    val horizontalAccuracy: Double? = null,
    val verticalAccuracy: Double? = null,
)

@Serializable
data class SessionStartPayload(
    val clientSessionId: String,
    val deviceId: String,
    val platform: String = "android",
    val deviceModel: String,
    val systemVersion: String,
    val appVersion: String,
    val sensorCapabilities: SensorCapabilities,
    val startedAt: String,
    /** Never sent on Android (§11): null is omitted by the encoder. */
    val strideCalibration: JsonElement? = null,
)

@Serializable
data class LastSequences(val location: Long, val motion: Long, val altimeter: Long, val pedometer: Long)

@Serializable
data class FinishPayload(
    val clientSessionId: String,
    val sessionId: String? = null,
    val endedAt: String,
    val lastSequences: LastSequences,
    val interrupted: Boolean? = null,
)

@Serializable
data class DiagnosticEventItem(
    val eventId: String,
    val eventType: String,
    val clientTimestamp: String,
    val metadata: Map<String, String> = emptyMap(),
)

@Serializable
data class DiagnosticEventPayload(val clientSessionId: String, val events: List<DiagnosticEventItem>)

@Serializable
data class CollectorStatusPayload(
    val sessionId: String,
    val collecting: Boolean,
    val locationSampleCount: Int,
    val motionSampleCount: Int,
    val pendingBatchCount: Int,
)

@Serializable
data class StrideCalibrationAck(val status: String? = null, val reason: String? = null)

@Serializable
data class SessionStartAckData(val sessionId: String? = null, val strideCalibration: StrideCalibrationAck? = null)

@Serializable
data class AckError(
    val code: String? = null,
    val message: String? = null,
    val status: Int? = null,
    val retryable: Boolean? = null,
)
