package hoshi.campustracker.sensors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class MotionAssemblerTest {
    private val ms = 1_000_000L

    @Test
    fun hundredHzInputIsThinnedToFiftyHz() {
        val a = MotionAssembler(50, 0.0)
        var emitted = 0
        val timestamps = mutableListOf<Long>()
        for (i in 0 until 200) { // 2 s at 100 Hz
            val t = i * 10 * ms
            a.onGravity(t, floatArrayOf(0f, 0f, 9.81f))
            a.onGyroscope(t, floatArrayOf(0f, 0f, 0f))
            a.onRotationVector(t, floatArrayOf(0f, 0f, 0f, 1f))
            a.onLinearAcceleration(t, floatArrayOf(0f, 0f, 0f))?.let { emitted++; timestamps += it.timestampNanos }
        }
        assertEquals(100, emitted)
        timestamps.zipWithNext().forEach { (p, n) -> assertEquals(20 * ms, n - p) }
    }

    @Test
    fun slightlyEarlyEventsStillEmit() {
        val a = MotionAssembler(50, 0.0)
        assertNotNull(a.onLinearAcceleration(0, floatArrayOf(0f, 0f, 0f)))
        assertNotNull(a.onLinearAcceleration(18 * ms, floatArrayOf(0f, 0f, 0f))) // ≥ 0.9 × 20 ms
        assertNull(a.onLinearAcceleration(30 * ms, floatArrayOf(0f, 0f, 0f))) // only 12 ms later
    }

    @Test
    fun staleOrMissingGroupsAreOmitted() {
        val a = MotionAssembler(50, 0.0)
        a.onGravity(0, floatArrayOf(0f, 0f, 9.81f))
        a.onRotationVector(0, floatArrayOf(0f, 0f, 0f, 1f))
        // gyro never arrived
        val first = a.onLinearAcceleration(40 * ms, floatArrayOf(1f, 0f, 0f))!!
        assertNotNull(first.gravity)
        assertNotNull(first.attitude)
        assertNull(first.rotationRate)
        assertEquals(-1 / 9.80665, first.userAcceleration!!.x!!, 1e-6)
        // 60 ms > 2.5 × 20 ms: gravity and attitude are now too old.
        val second = a.onLinearAcceleration(60 * ms, floatArrayOf(0f, 0f, 0f))!!
        assertNull(second.gravity)
        assertNull(second.attitude)
        assertEquals(60 * ms, second.timestampNanos)
    }
}
