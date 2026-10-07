package hoshi.campustracker.sensors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BarometerAggregatorTest {
    private val ms = 1_000_000L

    @Test
    fun averagesOneSecondWindowsInKpaWithFirstSampleZero() {
        val b = BarometerAggregator()
        val out = mutableListOf<AltimeterReading>()
        // 16 Hz events, window 1: 1002.0/1004.0 alternating (mean 1003.0); window 2: 1002.0 (pressure falls → up).
        for (i in 0 until 16) b.onPressure(i * 62 * ms, if (i % 2 == 0) 1002.0f else 1004.0f)?.let(out::add)
        for (i in 16 until 32) b.onPressure(i * 62 * ms + 20 * ms, 1002.0f)?.let(out::add)
        b.onPressure(2_100 * ms, 1002.0f)?.let(out::add)
        assertEquals(2, out.size)
        assertEquals(0.0, out[0].relativeAltitude!!, 1e-9)
        assertEquals(100.30, out[0].pressureKpa!!, 1e-6)
        val expectedRise = BarometerAggregator.altitudeMeters(1002.0) - BarometerAggregator.altitudeMeters(1003.0)
        assertEquals(expectedRise, out[1].relativeAltitude!!, 1e-6)
        assertTrue(out[1].relativeAltitude!! > 8.0) // ~8.3 m per hPa near sea level
        // Window timestamp is the mean of its event timestamps.
        assertEquals((0 until 16).map { it * 62 * ms }.average().toLong(), out[0].timestampNanos)
    }

    @Test
    fun restartStartsFromZeroAgain() {
        val first = BarometerAggregator()
        first.onPressure(0, 1000f)
        first.onPressure(1_000 * ms, 990f)
        val restarted = BarometerAggregator()
        assertNull(restarted.onPressure(0, 990f))
        val sample = restarted.onPressure(1_000 * ms, 990f)!!
        assertEquals(0.0, sample.relativeAltitude!!, 1e-9)
        assertEquals(99.0, sample.pressureKpa!!, 1e-6)
    }

    @Test
    fun altitudeFormulaMatchesPlatform() {
        // SensorManager.getAltitude(1013.25, 1013.25) == 0
        assertEquals(0.0, BarometerAggregator.altitudeMeters(1013.25), 1e-9)
        assertEquals(110.88, BarometerAggregator.altitudeMeters(1000.0), 0.1)
    }
}
