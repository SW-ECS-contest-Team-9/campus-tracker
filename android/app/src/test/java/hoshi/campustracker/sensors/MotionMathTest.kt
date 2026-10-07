package hoshi.campustracker.sensors

import hoshi.campustracker.sync.AttitudePayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

class MotionMathTest {
    private val eps = 1e-6

    @Test
    fun gravityAndLinearAccelerationAreNegatedAndScaledToG() {
        // Phone flat, screen up: Android TYPE_GRAVITY reports +9.80665 on z; CoreMotion gravity is (0, 0, -1).
        val g = MotionMath.toCoreMotionG(floatArrayOf(0f, 0f, 9.80665f))
        assertEquals(0.0, g.x!!, eps)
        assertEquals(0.0, g.y!!, eps)
        assertEquals(-1.0, g.z!!, 1e-6)
        // Lifting the phone up quickly: linear acceleration z > 0 on Android → userAcceleration.z < 0 (CoreMotion).
        val ua = MotionMath.toCoreMotionG(floatArrayOf(0.980665f, -1.96133f, 2.0f))
        assertEquals(-0.1, ua.x!!, 1e-6)
        assertEquals(0.2, ua.y!!, 1e-6)
        assertEquals(-2.0 / 9.80665, ua.z!!, 1e-6)
    }

    @Test
    fun nonFiniteValuesBecomeNull() {
        val g = MotionMath.toCoreMotionG(floatArrayOf(Float.NaN, Float.POSITIVE_INFINITY, 1f))
        assertNull(g.x)
        assertNull(g.y)
        assertEquals(-1 / 9.80665, g.z!!, 1e-6)
        assertNull(MotionMath.rotationRate(floatArrayOf(Float.NaN, 0f, 0f)).x)
    }

    @Test
    fun rotationRatePassesThrough() {
        val r = MotionMath.rotationRate(floatArrayOf(0.1f, -0.02f, 0.31f))
        assertEquals(0.1, r.x!!, 1e-6)
        assertEquals(-0.02, r.y!!, 1e-6)
        assertEquals(0.31, r.z!!, 1e-6)
    }

    @Test
    fun identityRotationGivesYawMinusHalfPi() {
        val a = MotionMath.attitudeFromMatrix(doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
        assertEquals(-PI / 2, a.yaw!!, eps)
        assertEquals(0.0, a.pitch!!, eps)
        assertEquals(0.0, a.roll!!, eps)
        // Same through the rotation-vector path (identity quaternion), 3- and 5-element forms.
        assertEquals(-PI / 2, MotionMath.attitude(floatArrayOf(0f, 0f, 0f)).yaw!!, eps)
        assertEquals(-PI / 2, MotionMath.attitude(floatArrayOf(0f, 0f, 0f, 1f, 0.3f)).yaw!!, eps)
    }

    @Test
    fun flatWithDeviceXNorthGivesYawZero() {
        // Device x → north (0,1,0), device y → west (-1,0,0), z up. Columns of R are the device axes in world.
        val r = doubleArrayOf(
            0.0, -1.0, 0.0,
            1.0, 0.0, 0.0,
            0.0, 0.0, 1.0,
        )
        assertEquals(0.0, MotionMath.attitudeFromMatrix(r).yaw!!, eps)
    }

    @Test
    fun flatWithTopEdgeNorthGivesYawMinusHalfPi() {
        assertEquals(-PI / 2, MotionMath.attitudeFromMatrix(rz(0.0)).yaw!!, eps)
    }

    @Test
    fun counterClockwiseRotationIncreasesYaw() {
        val before = MotionMath.attitudeFromMatrix(rz(0.0)).yaw!!
        val after = MotionMath.attitudeFromMatrix(rz(PI / 2)).yaw!!
        assertEquals(PI / 2, MotionMath.wrapToPi(after - before), eps)
        // Same via a quaternion about +z (CCW seen from above).
        val q = floatArrayOf(0f, 0f, sin(PI / 4).toFloat(), cos(PI / 4).toFloat())
        assertEquals(0.0, MotionMath.attitude(q).yaw!!, 1e-6)
    }

    @Test
    fun uprightPortraitGivesPitchHalfPi() {
        // Device y → up, device z → south (screen facing the user who looks north), device x → east.
        val r = doubleArrayOf(
            1.0, 0.0, 0.0,
            0.0, 0.0, -1.0,
            0.0, 1.0, 0.0,
        )
        assertEquals(PI / 2, MotionMath.attitudeFromMatrix(r).pitch!!, eps)
    }

    @Test
    fun rightEdgeDownGivesRollHalfPi() {
        // Device x → down, device z → east, device y → north.
        val r = doubleArrayOf(
            0.0, 0.0, 1.0,
            0.0, 1.0, 0.0,
            -1.0, 0.0, 0.0,
        )
        assertEquals(PI / 2, MotionMath.attitudeFromMatrix(r).roll!!, eps)
    }

    @Test
    fun declinationIsSubtractedFromYaw() {
        val decl = Math.toRadians(-8.7)
        val raw = MotionMath.attitudeFromMatrix(rz(0.3)).yaw!!
        val corrected = MotionMath.attitudeFromMatrix(rz(0.3), decl).yaw!!
        assertEquals(MotionMath.wrapToPi(raw - decl), corrected, eps)
    }

    @Test
    fun gravityMatchesAttitudeForRandomRotations() {
        // CoreMotion identity: gravity = (sin(roll)cos(pitch), −sin(pitch), −cos(roll)cos(pitch)).
        val random = Random(42)
        repeat(500) {
            val q = DoubleArray(4) { random.nextDouble(-1.0, 1.0) }
            val n = sqrt(q.sumOf { it * it })
            val rv = FloatArray(4) { (q[it] / n).toFloat() }
            val r = MotionMath.rotationMatrixFromVector(rv)
            // TYPE_GRAVITY in device frame = world up expressed in device coordinates = third row of R (× g0).
            val androidGravity = floatArrayOf((r[6] * 9.80665).toFloat(), (r[7] * 9.80665).toFloat(), (r[8] * 9.80665).toFloat())
            val g = MotionMath.toCoreMotionG(androidGravity)
            val a: AttitudePayload = MotionMath.attitudeFromMatrix(r)
            assertEquals(sin(a.roll!!) * cos(a.pitch!!), g.x!!, 1e-5)
            assertEquals(-sin(a.pitch!!), g.y!!, 1e-5)
            assertEquals(-cos(a.roll!!) * cos(a.pitch!!), g.z!!, 1e-5)
            assertEquals(1.0, sqrt(g.x!! * g.x!! + g.y!! * g.y!! + g.z!! * g.z!!), 1e-5)
        }
    }

    @Test
    fun rotationMatrixMatchesPlatformFormulaForQuaternion() {
        // 90° about x: device y → up, z → south.
        val s = sin(PI / 4).toFloat()
        val r = MotionMath.rotationMatrixFromVector(floatArrayOf(s, 0f, 0f, s))
        val expected = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0)
        expected.indices.forEach { assertEquals(expected[it], r[it], 1e-6) }
    }

    /** Flat (z up) rotated counter-clockwise by [theta] about the vertical. */
    private fun rz(theta: Double) = doubleArrayOf(
        cos(theta), -sin(theta), 0.0,
        sin(theta), cos(theta), 0.0,
        0.0, 0.0, 1.0,
    )
}
