package hoshi.campustracker.sensors

import hoshi.campustracker.core.finiteOrNull
import hoshi.campustracker.sync.AttitudePayload
import hoshi.campustracker.sync.Vec3
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * Converts Android sensor values to the CoreMotion (iPhone) meaning, units and signs the server's fusion expects
 * (§4.2). Pure functions so the conventions are unit-tested on the JVM.
 */
object MotionMath {
    const val G0 = 9.80665

    /**
     * TYPE_LINEAR_ACCELERATION / TYPE_GRAVITY (m/s², +up at rest) → CoreMotion g units (gravity points down).
     * The sign flip is intentional: the server is written against iPhone values as-is.
     */
    fun toCoreMotionG(values: FloatArray): Vec3 = Vec3(
        x = (-values[0] / G0).finiteOrNull(),
        y = (-values[1] / G0).finiteOrNull(),
        z = (-values[2] / G0).finiteOrNull(),
    )

    /** TYPE_GYROSCOPE rad/s: same axes and sign as CoreMotion. */
    fun rotationRate(values: FloatArray): Vec3 = Vec3(
        x = values[0].finiteOrNull(),
        y = values[1].finiteOrNull(),
        z = values[2].finiteOrNull(),
    )

    /**
     * Same result as `SensorManager.getRotationMatrixFromVector` (device → world (East, North, Up), row-major).
     * Only the first four values are used (some devices deliver five, which makes the platform call throw).
     */
    fun rotationMatrixFromVector(rotationVector: FloatArray): DoubleArray {
        val q1 = rotationVector[0].toDouble()
        val q2 = rotationVector[1].toDouble()
        val q3 = rotationVector[2].toDouble()
        val q0 = if (rotationVector.size >= 4) {
            rotationVector[3].toDouble()
        } else {
            val w = 1 - q1 * q1 - q2 * q2 - q3 * q3
            if (w > 0) sqrt(w) else 0.0
        }
        val sqQ1 = 2 * q1 * q1
        val sqQ2 = 2 * q2 * q2
        val sqQ3 = 2 * q3 * q3
        val q1q2 = 2 * q1 * q2
        val q3q0 = 2 * q3 * q0
        val q1q3 = 2 * q1 * q3
        val q2q0 = 2 * q2 * q0
        val q2q3 = 2 * q2 * q3
        val q1q0 = 2 * q1 * q0
        return doubleArrayOf(
            1 - sqQ2 - sqQ3, q1q2 - q3q0, q1q3 + q2q0,
            q1q2 + q3q0, 1 - sqQ1 - sqQ3, q2q3 - q1q0,
            q1q3 - q2q0, q2q3 + q1q0, 1 - sqQ1 - sqQ2,
        )
    }

    /**
     * CoreMotion Euler convention (R = Rz(yaw)·Rx(pitch)·Ry(roll), reference X = north, Z = up).
     * yaw is counter-clockwise positive seen from above. [declinationRad] is subtracted only for a true-north frame.
     */
    fun attitudeFromMatrix(r: DoubleArray, declinationRad: Double = 0.0): AttitudePayload {
        val yawRaw = atan2(-r[4], -r[1])
        val pitch = asin(r[7].coerceIn(-1.0, 1.0))
        val roll = atan2(-r[6], r[8])
        val yaw = wrapToPi(yawRaw - declinationRad)
        return AttitudePayload(roll = roll.finiteOrNull(), pitch = pitch.finiteOrNull(), yaw = yaw.finiteOrNull())
    }

    fun attitude(rotationVector: FloatArray, declinationRad: Double = 0.0): AttitudePayload =
        attitudeFromMatrix(rotationMatrixFromVector(rotationVector), declinationRad)

    fun wrapToPi(angle: Double): Double {
        if (!angle.isFinite()) return angle
        var a = angle % (2 * PI)
        if (a > PI) a -= 2 * PI
        if (a <= -PI) a += 2 * PI
        return a
    }
}
