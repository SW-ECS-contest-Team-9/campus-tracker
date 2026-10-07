package hoshi.campustracker.sensors

import hoshi.campustracker.model.CaptureSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StepCounterTrackerTest {
    @Test
    fun firstEventIsTheBaselineAndOnlyIncreasesAreEmitted() {
        val t = StepCounterTracker()
        assertNull(t.onCounter(5_000, 1_000))
        assertEquals(5_000L, t.baseline)
        assertNull(t.onCounter(5_000, 2_000)) // 0 steps: never a zero sample
        assertEquals(StepReading(3_000, 3, CaptureSource.LIVE), t.onCounter(5_003, 3_000))
        assertNull(t.onCounter(5_003, 4_000)) // repeat
        assertNull(t.onCounter(5_001, 5_000)) // backwards
        assertEquals(StepReading(6_000, 10, CaptureSource.LIVE), t.onCounter(5_010, 6_000))
    }

    @Test
    fun resumeOnSameBootEmitsOneHistoricalRecoverySample() {
        val t = StepCounterTracker(StepRestore(baseline = 5_000, bootCount = 7, lastTotal = 40, lastSampleMs = 10_000), currentBootCount = 7)
        assertEquals(StepReading(20_000, 95, CaptureSource.HISTORICAL_RECOVERY), t.onCounter(5_095, 20_000))
        assertEquals(StepReading(21_000, 97, CaptureSource.LIVE), t.onCounter(5_097, 21_000))
    }

    @Test
    fun resumeOnSameBootWithoutNewStepsEmitsNothing() {
        val t = StepCounterTracker(StepRestore(5_000, 7, 40, 10_000), 7)
        assertNull(t.onCounter(5_040, 20_000))
        assertEquals(StepReading(21_000, 41, CaptureSource.LIVE), t.onCounter(5_041, 21_000))
    }

    @Test
    fun resumeAfterRebootContinuesTheCumulativeCount() {
        val t = StepCounterTracker(StepRestore(5_000, 7, 40, 10_000), currentBootCount = 8)
        assertNull(t.onCounter(12, 20_000)) // new baseline = 12 − 40
        assertEquals(-28L, t.baseline)
        assertEquals(StepReading(21_000, 45, CaptureSource.LIVE), t.onCounter(17, 21_000))
    }
}
