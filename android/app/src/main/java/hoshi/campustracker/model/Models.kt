package hoshi.campustracker.model

import hoshi.campustracker.core.Iso
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement

/** Epoch milliseconds stored as an ISO-8601 millisecond string (local files use the wire format too, §12-11). */
object IsoMillisSerializer : KSerializer<Long> {
    override val descriptor = PrimitiveSerialDescriptor("IsoMillis", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeString(Iso.format(value))
    override fun deserialize(decoder: Decoder): Long =
        Iso.parse(decoder.decodeString()) ?: throw IllegalArgumentException("invalid ISO-8601 timestamp")
}

typealias IsoMillis = @Serializable(with = IsoMillisSerializer::class) Long

/**
 * Same keys as iOS `SensorCapabilities` plus Android-only keys (§4.5). Every field has a default so older
 * persisted JSON without a key still decodes.
 */
@Serializable
data class SensorCapabilities(
    val locationAvailable: Boolean = false,
    val deviceMotionAvailable: Boolean = false,
    val altimeterAvailable: Boolean = false,
    val stepCountingAvailable: Boolean = false,
    val distanceAvailable: Boolean = false,
    val floorCountingAvailable: Boolean = false,
    val paceAvailable: Boolean = false,
    val cadenceAvailable: Boolean = false,
    val attitudeReferenceFrame: String? = null,
    val motionUpdateHz: Int? = null,
    val locationAuthorization: String? = null,
    val locationAccuracyAuthorization: String? = null,
    val backgroundLocationUpdates: Boolean? = null,
    val pausesLocationUpdatesAutomatically: Boolean? = null,
    // Android-only
    val attitudeSensor: String? = null,
    val magneticDeclinationDeg: Double? = null,
    val locationProvider: String? = null,
    val motionConvention: String? = null,
) {
    companion object {
        /** Marks the §4.2 conversion (negated, g-scaled acceleration/gravity; CoreMotion Euler angles). */
        const val MOTION_CONVENTION = "COREMOTION_G_V1"
    }
}

@Serializable
enum class CollectionStatus { recording, completed }

@Serializable
data class SampleCounts(
    val location: Int = 0,
    val motion: Int = 0,
    val altimeter: Int = 0,
    val pedometer: Int = 0,
    val marker: Int = 0,
)

/** Local session object (`metadata.json`). `id` is the clientSessionId. */
@Serializable
data class CollectionSession(
    val id: String,
    val collectorId: String,
    val deviceId: String,
    val startedAt: IsoMillis,
    val endedAt: IsoMillis? = null,
    val status: CollectionStatus = CollectionStatus.recording,
    val serverSessionId: String? = null,
    val deviceModel: String = "",
    val systemVersion: String = "",
    val sensorCapabilities: SensorCapabilities = SensorCapabilities(),
    val sampleCounts: SampleCounts = SampleCounts(),
    /** Always null on Android (§11); kept so the shape matches iOS. */
    val strideCalibration: JsonElement? = null,
)

@Serializable
enum class MotionSamplingRate(val hz: Int, val label: String) {
    hz10(10, "10 Hz"), hz20(20, "20 Hz"), hz50(50, "50 Hz");

    val periodNanos: Long get() = 1_000_000_000L / hz

    companion object {
        /** 50 Hz, not iOS' 20 Hz: the server's step-detection filter is designed for 50 Hz input (§12-1). */
        val DEFAULT = hz50
        fun fromHz(hz: Int): MotionSamplingRate = entries.firstOrNull { it.hz == hz } ?: DEFAULT
    }
}

@Serializable
enum class LocationCollectionProfile(val title: String, val intervalMs: Long) {
    highAccuracy("High Accuracy Collection", 1_000),
    balanced("Balanced Collection", 2_000),
    batterySaving("Battery Saving", 5_000);

    companion object {
        val DEFAULT = highAccuracy
        fun fromName(name: String?): LocationCollectionProfile = entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

enum class EventMarkerType(val wire: String, val title: String) {
    entrance("entrance", "Entrance"),
    intersection("intersection", "Intersection"),
    stairStart("stairStart", "Stair Start"),
    stairEnd("stairEnd", "Stair End"),
    rampStart("rampStart", "Ramp Start"),
    rampEnd("rampEnd", "Ramp End"),
    elevator("elevator", "Elevator"),
    stop("stop", "Stop"),
    custom("custom", "Custom"),
}

enum class CollectorAppState(val wire: String) { FOREGROUND("FOREGROUND"), INACTIVE("INACTIVE"), BACKGROUND("BACKGROUND") }

object CaptureSource {
    const val LIVE = "LIVE"
    const val HISTORICAL_RECOVERY = "HISTORICAL_RECOVERY"
}

/** Most recent fix kept in memory for markers. */
data class LocationFix(
    val latitude: Double,
    val longitude: Double,
    val altitude: Double?,
    val ellipsoidalAltitude: Double?,
    val horizontalAccuracy: Double?,
    val verticalAccuracy: Double?,
)

/** Identity sent with login and `session:start`; deviceId must be byte-identical everywhere (§3.3). */
data class DeviceInfo(
    val deviceId: String,
    val deviceModel: String,
    val systemVersion: String,
    val appVersion: String,
)
