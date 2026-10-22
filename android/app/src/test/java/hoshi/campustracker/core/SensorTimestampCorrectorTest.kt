package hoshi.campustracker.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SensorTimestampCorrectorTest {
    private class Clock(var elapsedNanos: Long) : CollectorClock {
        override fun nowMs() = elapsedNanos / 1_000_000
        override fun epochMs(elapsedRealtimeNanos: Long) = elapsedRealtimeNanos / 1_000_000
        override fun elapsedRealtimeNanos() = elapsedNanos
    }

    private val ms = 1_000_000L

    /** Feeds [count] events 20 ms apart; [residualMs] gives `now − event` for event i. */
    private fun run(corrector: SensorTimestampCorrector, clock: Clock, count: Int, residualMs: (Int) -> Long): ClockCalibration? {
        var result: ClockCalibration? = null
        for (i in 0 until count) {
            val event = 10_000 * ms + i * 20 * ms
            clock.elapsedNanos = event + residualMs(i) * ms
            corrector.observe(event)?.let { result = it }
        }
        return result
    }

    @Test
    fun lateFirstCallbackIsNotAdoptedAsAnOffset() {
        val clock = Clock(0)
        val corrector = SensorTimestampCorrector(clock, calibrationEvents = 5)
        // The first callback waited 3 s (a burst); the later ones are prompt.
        val result = run(corrector, clock, 5) { if (it == 0) 3_000 else 4 }!!
        assertEquals(0L, result.offsetMs)
        assertEquals(3_000L, result.firstResidualMs)
        assertEquals(4L, result.minResidualMs)
        assertTrue(result.mappingUncertain)
        assertEquals(123 * ms, corrector.correct(123 * ms))
    }

    @Test
    fun differentClockBaseOnEveryEventIsCorrected() {
        val clock = Clock(0)
        val corrector = SensorTimestampCorrector(clock, calibrationEvents = 5)
        // Sensor stamps lag elapsedRealtime by 40 s (e.g. a clock that stops in deep sleep) plus a few ms of delivery.
        val result = run(corrector, clock, 5) { 40_000L + (it % 3) }!!
        assertEquals(40_000L, result.offsetMs)
        assertFalse(result.mappingUncertain)
        assertEquals(41_000 * ms, corrector.correct(1_000 * ms))
    }

    @Test
    fun decidesOnceAfterTheWindowAndNeverChangesAgain() {
        val clock = Clock(0)
        val corrector = SensorTimestampCorrector(clock, calibrationEvents = 3)
        assertNull(run(corrector, clock, 2) { 5 })
        assertFalse(corrector.isCalibrated)
        val result = run(corrector, clock, 1) { 5 }!!
        assertEquals(0L, result.offsetMs)
        assertFalse(result.mappingUncertain)
        assertTrue(corrector.isCalibrated)
        assertNull(run(corrector, clock, 3) { 90_000 })
        assertEquals(0L, corrector.offsetNanos)
    }

    @Test
    fun eventsAheadOfTheClockAreCorrected() {
        val clock = Clock(0)
        val corrector = SensorTimestampCorrector(clock, calibrationEvents = 4)
        val result = run(corrector, clock, 4) { -5_000 }!!
        assertEquals(-5_000L, result.offsetMs)
    }
}
