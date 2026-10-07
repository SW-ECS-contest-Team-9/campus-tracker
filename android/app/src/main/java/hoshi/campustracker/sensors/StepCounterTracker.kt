package hoshi.campustracker.sensors

import hoshi.campustracker.model.CaptureSource

/** Cumulative steps for one pedometer run (sensorSegmentId), as the server requires (§4.4). */
data class StepReading(val timestampMs: Long, val steps: Long, val captureSource: String)

/** What the previous (interrupted) process knew, persisted in the active-collection state. */
data class StepRestore(val baseline: Long, val bootCount: Int?, val lastTotal: Long, val lastSampleMs: Long?)

/**
 * Turns TYPE_STEP_COUNTER (steps since boot) into a strictly increasing cumulative count. The only producer of
 * pedometer samples: no zero samples, no repeats, no increments, no snapshots.
 */
class StepCounterTracker(restore: StepRestore? = null, currentBootCount: Int? = null) {
    private enum class Mode { FRESH, SAME_BOOT, REBOOTED }

    private var mode: Mode
    var baseline: Long? = null
        private set
    var lastTotal: Long = 0
        private set
    private val lastSampleMs: Long?
    private var firstEventSeen = false

    init {
        if (restore == null) {
            mode = Mode.FRESH
            lastSampleMs = null
        } else {
            lastTotal = restore.lastTotal
            lastSampleMs = restore.lastSampleMs
            val sameBoot = restore.bootCount != null && currentBootCount != null && restore.bootCount == currentBootCount
            mode = if (sameBoot) Mode.SAME_BOOT else Mode.REBOOTED
            if (sameBoot) baseline = restore.baseline
        }
    }

    fun onCounter(counterValue: Long, timestampMs: Long): StepReading? {
        if (!firstEventSeen) {
            firstEventSeen = true
            when (mode) {
                Mode.FRESH -> {
                    baseline = counterValue
                    return null
                }
                Mode.REBOOTED -> {
                    baseline = counterValue - lastTotal
                    return null
                }
                Mode.SAME_BOOT -> {
                    val base = baseline ?: counterValue.also { baseline = it }
                    if (counterValue < base) {
                        // Counter went backwards although the boot count matched: continue like a reboot.
                        baseline = counterValue - lastTotal
                        return null
                    }
                    val total = counterValue - base
                    val after = lastSampleMs == null || timestampMs > lastSampleMs
                    if (total > lastTotal && after) {
                        lastTotal = total
                        return StepReading(timestampMs, total, CaptureSource.HISTORICAL_RECOVERY)
                    }
                    return null
                }
            }
        }
        val base = baseline ?: return null
        val total = counterValue - base
        if (total <= lastTotal) return null
        lastTotal = total
        return StepReading(timestampMs, total, CaptureSource.LIVE)
    }
}
