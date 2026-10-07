package hoshi.campustracker.sensors

import hoshi.campustracker.core.finiteOrNull
import kotlin.math.pow

/** One CMAltimeter-equivalent sample: kPa and metres relative to the first window of this run (§4.3). */
data class AltimeterReading(val timestampNanos: Long, val relativeAltitude: Double?, val pressureKpa: Double?)

/**
 * Averages TYPE_PRESSURE (hPa) over 1 s windows — the only smoothing allowed (§4.3/§14), because iOS values are
 * already filtered. One instance per barometer run: a restart gets a new instance, so a new p0 and a first sample of 0.
 */
class BarometerAggregator(private val windowNanos: Long = 1_000_000_000L) {
    private var windowStart: Long? = null
    private var sumHpa = 0.0
    private var sumTimestamp = 0.0
    private var count = 0
    private var p0Altitude: Double? = null

    /** Feeds one event; returns the finished window's sample when this event starts a new window. */
    fun onPressure(timestampNanos: Long, hPa: Float): AltimeterReading? {
        if (!hPa.isFinite()) return null
        val start = windowStart
        var emitted: AltimeterReading? = null
        if (start != null && timestampNanos - start >= windowNanos && count > 0) {
            emitted = emit()
        }
        if (windowStart == null) windowStart = timestampNanos
        sumHpa += hPa
        sumTimestamp += timestampNanos.toDouble()
        count += 1
        return emitted
    }

    private fun emit(): AltimeterReading {
        val meanHpa = sumHpa / count
        val meanTs = (sumTimestamp / count).toLong()
        val h = altitudeMeters(meanHpa)
        val h0 = p0Altitude ?: h.also { p0Altitude = it }
        windowStart = null
        sumHpa = 0.0
        sumTimestamp = 0.0
        count = 0
        return AltimeterReading(meanTs, (h - h0).finiteOrNull(), (meanHpa / 10.0).finiteOrNull())
    }

    companion object {
        const val PRESSURE_STANDARD_ATMOSPHERE = 1013.25

        /** Same formula as `SensorManager.getAltitude(PRESSURE_STANDARD_ATMOSPHERE, p)`. */
        fun altitudeMeters(hPa: Double): Double =
            44330.0 * (1.0 - (hPa / PRESSURE_STANDARD_ATMOSPHERE).pow(1.0 / 5.255))
    }
}
