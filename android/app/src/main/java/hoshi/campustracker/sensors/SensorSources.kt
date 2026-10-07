package hoshi.campustracker.sensors

import hoshi.campustracker.model.LocationCollectionProfile

/** A fix already mapped to the iPhone field meanings (§4.1). Fields the provider does not report are null. */
data class LocationReading(
    val timestampMs: Long,
    val latitude: Double,
    val longitude: Double,
    /** Mean-sea-level altitude; never the ellipsoidal height. */
    val altitude: Double?,
    /** WGS84 ellipsoidal height (`Location.getAltitude()` on Android). */
    val ellipsoidalAltitude: Double?,
    val horizontalAccuracy: Double?,
    val verticalAccuracy: Double?,
    val speed: Double?,
    val course: Double?,
    val speedAccuracy: Double?,
    val courseAccuracy: Double?,
)

/** Position used only for the magnetic declination; never recorded as a sample. */
data class KnownPosition(val latitude: Double, val longitude: Double, val altitude: Double)

/** Attitude source and frame, fixed once per session (§4.2). */
data class AttitudeChoice(
    /** `ROTATION_VECTOR` or `GAME_ROTATION_VECTOR`. */
    val sensor: String,
    /** `xTrueNorthZVertical`, `xMagneticNorthZVertical` or `xArbitraryZVertical`. */
    val referenceFrame: String,
    val declinationDeg: Double?,
) {
    val declinationRad: Double get() = Math.toRadians(declinationDeg ?: 0.0)

    companion object {
        const val ROTATION_VECTOR = "ROTATION_VECTOR"
        const val GAME_ROTATION_VECTOR = "GAME_ROTATION_VECTOR"
        const val TRUE_NORTH = "xTrueNorthZVertical"
        const val MAGNETIC_NORTH = "xMagneticNorthZVertical"
        const val ARBITRARY = "xArbitraryZVertical"
    }
}

interface LocationSource {
    val isActive: Boolean
    /** `fused` or `gps` (written to `sensorCapabilities.locationProvider`). */
    val providerLabel: String
    fun start(profile: LocationCollectionProfile, distanceFilterMeters: Double, onLocation: (LocationReading) -> Unit): Boolean
    fun stop()
    /** Last known position for the declination. Calls back on the collection thread, null when unknown. */
    fun lastKnownPosition(callback: (KnownPosition?) -> Unit)
}

interface MotionSource {
    val isAvailable: Boolean
    val isActive: Boolean
    fun chooseAttitude(position: KnownPosition?, nowMs: Long): AttitudeChoice
    fun start(
        hz: Int,
        attitude: AttitudeChoice,
        onReading: (MotionReading) -> Unit,
        onRotationAccuracyChanged: (Int) -> Unit,
        onClockOffset: (Long) -> Unit,
    )
    fun stop()
    /** Epoch ms for a reading's corrected sensor timestamp. */
    fun epochMs(timestampNanos: Long): Long
}

interface AltimeterSource {
    val isAvailable: Boolean
    val isActive: Boolean
    fun start(onReading: (AltimeterReading) -> Unit)
    fun stop()
    fun epochMs(timestampNanos: Long): Long
}

interface PedometerSource {
    /** Sensor present and ACTIVITY_RECOGNITION granted. */
    val isAvailable: Boolean
    val isActive: Boolean
    fun currentBootCount(): Int?
    /** Returns false (and reports through [onError]) when the listener could not be registered. */
    fun start(
        restore: StepRestore?,
        onReading: (StepReading) -> Unit,
        onProgress: (baseline: Long?, lastTotal: Long) -> Unit,
        onError: (String) -> Unit,
    ): Boolean
    fun stop()
}
