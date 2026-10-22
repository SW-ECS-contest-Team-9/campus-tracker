package hoshi.campustracker.positioning

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * The beacon measurement model shared with the server's fusion-v4 (backend/src/modules/fusion/fusion-beacon.ts and
 * positioning/beacon-calibration.ts): the same calibration choice, log-distance model and RSSI window filter, checked
 * against the same fixture (fixtures/beacon/measurement-model.json). The collector app has no on-device fusion
 * engine (fusion runs on the server); this is the measurement front-end a future on-device / navigator engine
 * plugs into, and lets the collector show what a beacon is worth.
 */
data class RssiModel(val measuredPower1m: Double, val pathLossExponent: Double, val rssiVariance: Double, val source: String) {
    /** d = 10^((P1m - rssi) / (10 n)), metres (3D). */
    fun range(rssi: Double): Double = 10.0.pow((measuredPower1m - rssi) / (10 * pathLossExponent))

    /** 1-sigma of ln(range): sigma_dB ln10 / (10 n). */
    val lnRangeSigma: Double get() = sqrt(rssiVariance) * ln(10.0) / (10 * pathLossExponent)

    companion object {
        val DEFAULTS = RssiModel(-59.0, 2.2, 36.0, "DEFAULT")

        /**
         * Most specific calibration: this beacon x platform x device model, beacon x platform, beacon, then the same
         * three without a beacon, then the advertised 1 m power, then defaults. A calibration of one platform is never
         * used on the other (iOS ranging aggregates, Android single advertisements).
         */
        fun select(
            rows: List<BeaconCalibration>, beaconId: String?, platform: String, deviceModel: String?, advertisedPower: Int?,
            defaults: RssiDefaults = RssiDefaults(),
        ): RssiModel {
            val order = listOf(
                Triple(beaconId, platform to (deviceModel ?: ""), "BEACON_DEVICE"),
                Triple(beaconId, platform to "*", "BEACON_PLATFORM"),
                Triple(beaconId, "*" to "*", "BEACON"),
                Triple(null, platform to (deviceModel ?: ""), "GLOBAL_DEVICE"),
                Triple(null, platform to "*", "GLOBAL_PLATFORM"),
                Triple(null, "*" to "*", "GLOBAL"),
            )
            for ((b, pg, source) in order) {
                if (b == null && source.startsWith("BEACON")) continue
                if (pg.second.isEmpty()) continue
                rows.firstOrNull { it.beaconId == b && it.platform == pg.first && it.deviceGroup == pg.second }?.let {
                    return RssiModel(it.measuredPower1m, it.pathLossExponent, it.rssiVariance, source)
                }
            }
            if (advertisedPower != null && advertisedPower < 0) {
                return RssiModel(advertisedPower.toDouble(), defaults.pathLossExponent, defaults.rssiVariance, "ADVERTISED")
            }
            return RssiModel(defaults.measuredPower1m, defaults.pathLossExponent, defaults.rssiVariance, "DEFAULT")
        }
    }
}

/** One filtered measurement: what a fusion engine consumes (never a coordinate). */
data class BeaconRangeMeasurement(
    val beaconKey: String,
    val tEpochMs: Long,
    val medianRssi: Double,
    /** model range (3D, m), ln of it and the variance of ln(range) */
    val rangeM: Double,
    val lnRange: Double,
    val lnVariance: Double,
    /** upper 2-sigma range */
    val upperRangeM: Double,
    val samples: Int,
)

enum class MeasurementRejection { RSSI_OUT_OF_RANGE, RSSI_OUTLIER, TOO_FAR, THROTTLED, STALE }

/**
 * Per-beacon RSSI window: median, MAD outlier rejection, one measurement per beacon per [updateIntervalMs], samples
 * older than [windowMs] dropped and observations older than the newest by [maxAgeMs] refused. Same constants as
 * fusion-v4 rev 18 (fusion.config.ts beacon*).
 */
class BeaconMeasurementFilter(
    private val windowMs: Long = 3_000,
    private val updateIntervalMs: Long = 1_000,
    private val maxAgeMs: Long = 4_000,
    private val minRssi: Double = -100.0,
    private val maxRssi: Double = -20.0,
    private val outlierMinDb: Double = 8.0,
    private val maxEffectiveSamples: Int = 3,
    private val minRangeM: Double = 0.5,
    private val maxRangeM: Double = 25.0,
) {
    private class Sample(val t: Long, val rssi: Double, val n: Int)
    private class Channel { val samples = ArrayDeque<Sample>(); var lastUpdate: Long? = null }
    private val channels = HashMap<String, Channel>()
    private var newestMs = Long.MIN_VALUE

    /** Returns the measurement when this beacon is due, or the reason it is not. */
    fun add(key: String, tEpochMs: Long, rssi: Double, sampleCount: Int, model: RssiModel, anchorAccuracyM: Double = 0.0): Result<BeaconRangeMeasurement> {
        if (rssi.isNaN() || rssi < minRssi || rssi > maxRssi) return fail(MeasurementRejection.RSSI_OUT_OF_RANGE)
        if (newestMs != Long.MIN_VALUE && tEpochMs < newestMs - maxAgeMs) return fail(MeasurementRejection.STALE)
        newestMs = max(newestMs, tEpochMs)
        val ch = channels.getOrPut(key) { Channel() }
        ch.samples.removeAll { it.t <= tEpochMs - windowMs || it.t > tEpochMs }
        if (ch.samples.size >= 3) {
            val m = median(ch.samples.map { it.rssi })
            val mad = median(ch.samples.map { abs(it.rssi - m) })
            if (abs(rssi - m) > max(outlierMinDb, 3 * 1.4826 * mad)) return fail(MeasurementRejection.RSSI_OUTLIER)
        }
        ch.samples.addLast(Sample(tEpochMs, rssi, max(1, sampleCount)))
        ch.lastUpdate?.let { if (tEpochMs - it < updateIntervalMs) return fail(MeasurementRejection.THROTTLED) }
        ch.lastUpdate = tEpochMs
        val med = median(ch.samples.map { it.rssi })
        val range = max(minRangeM, model.range(med))
        if (range > maxRangeM) return fail(MeasurementRejection.TOO_FAR)
        val n = min(maxEffectiveSamples, ch.samples.sumOf { it.n })
        val variance = model.lnRangeSigma.pow(2) / n + (anchorAccuracyM / max(range, 1.0)).pow(2)
        return Result.success(BeaconRangeMeasurement(key, tEpochMs, med, range, ln(range), variance, range * exp(2 * sqrt(variance)), n))
    }

    /** Signal loss / session end: forget every window (the next observation starts a fresh one). */
    fun reset() {
        channels.clear()
        newestMs = Long.MIN_VALUE
    }

    private fun fail(r: MeasurementRejection): Result<BeaconRangeMeasurement> = Result.failure(Rejected(r))
    class Rejected(val reason: MeasurementRejection) : Exception(reason.name)

    private fun median(v: List<Double>): Double {
        val s = v.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }
}
