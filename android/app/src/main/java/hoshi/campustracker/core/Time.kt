package hoshi.campustracker.core

import android.os.SystemClock
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs

/** ISO-8601 UTC with exactly three fractional digits, e.g. `2026-10-07T06:00:00.123Z` (server contract §3.1). */
object Iso {
    private val formatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun format(epochMs: Long): String = formatter.format(Instant.ofEpochMilli(epochMs))

    fun parse(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
}

/**
 * One clock for every sample, marker, diagnostic event, `startedAt` and `endedAt` (§4.0).
 * Equivalent of iOS `bootTime + motion.timestamp`.
 */
interface CollectorClock {
    /** Epoch milliseconds now. */
    fun nowMs(): Long

    /** Epoch milliseconds for an `elapsedRealtimeNanos` measurement (Location, corrected SensorEvent). */
    fun epochMs(elapsedRealtimeNanos: Long): Long

    /** Current `SystemClock.elapsedRealtimeNanos()`. */
    fun elapsedRealtimeNanos(): Long
}

class SystemCollectorClock : CollectorClock {
    // Computed once at process start and fixed for the lifetime of the process.
    private val bootEpochMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()

    override fun nowMs(): Long = bootEpochMs + SystemClock.elapsedRealtime()
    override fun epochMs(elapsedRealtimeNanos: Long): Long = bootEpochMs + elapsedRealtimeNanos / 1_000_000
    override fun elapsedRealtimeNanos(): Long = SystemClock.elapsedRealtimeNanos()
}

/** Outcome of [SensorTimestampCorrector] calibration (reported once per process). */
data class ClockCalibration(
    /** Applied to every later sensor timestamp; 0 when the clocks agree. */
    val offsetMs: Long,
    /** `now − event` of the first motion event (delivery delay + clock difference). */
    val firstResidualMs: Long,
    /** Smallest `now − event` over the calibration window: the clock difference estimate. */
    val minResidualMs: Long,
    val events: Int,
) {
    /** The first event looked late although the clocks agree: a delivery delay, not a clock base (iOS name). */
    val mappingUncertain: Boolean get() = offsetMs == 0L && abs(firstResidualMs) >= SensorTimestampCorrector.TOLERANCE_MS
}

/**
 * Some devices stamp `SensorEvent.timestamp` on a base other than `elapsedRealtimeNanos` (§4.0). A delayed first
 * callback must not become a permanent offset (2026-10-14 tracking correction, T1): a delivery delay only adds to
 * `now − event`, a different clock base shifts every event. So the offset is the smallest residual over the first
 * [calibrationEvents] motion events, applied only when it falls outside 0..2 s. Events of that window are held by the
 * motion source and released with the decided offset, so no sample changes its time base mid-stream.
 */
class SensorTimestampCorrector(private val clock: CollectorClock, private val calibrationEvents: Int = 25) {
    companion object {
        const val TOLERANCE_MS = 2_000L
    }

    @Volatile var offsetNanos: Long = 0L
        private set

    @Volatile var isCalibrated = false
        private set

    private var seen = 0
    private var firstResidual = 0L
    private var minResidual = Long.MAX_VALUE

    /** Feeds one motion event; returns the decision exactly once, when the window is complete. */
    fun observe(eventTimestampNanos: Long): ClockCalibration? {
        if (isCalibrated) return null
        val residual = clock.elapsedRealtimeNanos() - eventTimestampNanos
        if (seen == 0) firstResidual = residual
        minResidual = minOf(minResidual, residual)
        seen += 1
        if (seen < calibrationEvents) return null
        if (minResidual !in 0L..TOLERANCE_MS * 1_000_000) offsetNanos = minResidual
        isCalibrated = true
        return ClockCalibration(offsetNanos / 1_000_000, firstResidual / 1_000_000, minResidual / 1_000_000, seen)
    }

    fun correct(eventTimestampNanos: Long): Long = eventTimestampNanos + offsetNanos
}
