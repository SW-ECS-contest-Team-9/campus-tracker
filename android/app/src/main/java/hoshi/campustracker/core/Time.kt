package hoshi.campustracker.core

import android.os.SystemClock
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

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

/**
 * Some devices stamp `SensorEvent.timestamp` on a base other than `elapsedRealtimeNanos`. The first motion
 * event decides a fixed offset for the whole run (§4.0).
 */
class SensorTimestampCorrector(private val clock: CollectorClock) {
    @Volatile var offsetNanos: Long = 0L
        private set

    @Volatile private var calibrated = false

    /** Returns the offset in ms when this call applied a non-zero correction, null otherwise. */
    fun calibrateIfNeeded(eventTimestampNanos: Long): Long? {
        if (calibrated) return null
        calibrated = true
        val diff = clock.elapsedRealtimeNanos() - eventTimestampNanos
        if (diff in 0L..2_000_000_000L) return null
        offsetNanos = diff
        return diff / 1_000_000
    }

    fun correct(eventTimestampNanos: Long): Long = eventTimestampNanos + offsetNanos
}
