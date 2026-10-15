package hoshi.campustracker.positioning

import java.util.UUID

/** How one RSSI value came about (platform difference kept explicit; the server and fusion read it). */
object RssiAggregation {
    /** Android: one advertisement as reported by one ScanResult. */
    const val SINGLE_ADVERTISEMENT = "SINGLE_ADVERTISEMENT"
    /** iOS: Core Location ranging, an aggregate over about one second. */
    const val CORE_LOCATION_RANGING = "CORE_LOCATION_RANGING"
}

/**
 * Platform-neutral beacon observation (the `beacon.observations.v1` row before serialization). Shared by the
 * collector and a future navigator: it carries no session or upload state.
 *
 * Time: [observedAtEpochMs] is derived from [elapsedRealtimeNanos] (ScanResult.timestampNanos, the same monotonic
 * clock as Location and SensorEvent) through the collector clock, so beacons line up with the other sensor streams.
 */
data class BeaconObservation(
    val observationId: String,
    val protocol: String = "IBEACON",
    val uuid: String,
    val major: Int,
    val minor: Int,
    val rssiDbm: Int,
    val observedAtEpochMs: Long,
    val elapsedRealtimeNanos: Long?,
    val measuredPowerDbm: Int? = null,
    /** platform distance estimate (iOS CLBeacon.accuracy); reference only, never a range measurement */
    val platformEstimatedDistanceMeters: Double? = null,
    val proximity: String? = null,
    val observationTimeUncertaintyMs: Double? = null,
    val rssiAggregation: String,
    val sampleCount: Int? = null,
) {
    val key: String get() = beaconKey(uuid, major, minor)
}

/** Why a scan result did not become an observation. */
enum class ObservationRejection { NOT_IBEACON, RSSI_UNUSABLE, NOT_REGISTERED }

/**
 * ScanResult -> [BeaconObservation] without Android types (the scanner hands over the raw values). Physically
 * meaningless RSSI (Android reports 127 for "unavailable") is dropped here; registered-UUID filtering happens when a
 * registry is known (the ScanFilter already restricts to its UUIDs, this is the second check).
 */
class BeaconObservationNormalizer(
    private val epochMs: (elapsedRealtimeNanos: Long) -> Long,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    companion object {
        const val RSSI_MIN = -120
        const val RSSI_MAX = -1
        /** ScanResult timestamps are taken in the Bluetooth stack: a few ms from the radio event. */
        const val ANDROID_TIME_UNCERTAINTY_MS = 10.0
    }

    fun normalize(
        manufacturerId: Int,
        manufacturerData: ByteArray?,
        rssi: Int,
        timestampNanos: Long,
        acceptedUuids: Set<String>?,
    ): Result<BeaconObservation> {
        val frame = IBeaconParser.parse(manufacturerId, manufacturerData) ?: return Result.failure(Rejected(ObservationRejection.NOT_IBEACON))
        if (rssi < RSSI_MIN || rssi > RSSI_MAX) return Result.failure(Rejected(ObservationRejection.RSSI_UNUSABLE))
        if (acceptedUuids != null && frame.uuid !in acceptedUuids) return Result.failure(Rejected(ObservationRejection.NOT_REGISTERED))
        return Result.success(
            BeaconObservation(
                observationId = newId(), uuid = frame.uuid, major = frame.major, minor = frame.minor, rssiDbm = rssi,
                observedAtEpochMs = epochMs(timestampNanos), elapsedRealtimeNanos = timestampNanos,
                measuredPowerDbm = frame.measuredPowerDbm, observationTimeUncertaintyMs = ANDROID_TIME_UNCERTAINTY_MS,
                rssiAggregation = RssiAggregation.SINGLE_ADVERTISEMENT, sampleCount = 1,
            ),
        )
    }

    class Rejected(val reason: ObservationRejection) : Exception(reason.name)
}
