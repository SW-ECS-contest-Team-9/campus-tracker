package hoshi.campustracker.sensors

import hoshi.campustracker.sync.AttitudePayload
import hoshi.campustracker.sync.Vec3

/** One CMDeviceMotion-equivalent sample, already converted (§4.2). [timestampNanos] is corrected elapsedRealtime. */
data class MotionReading(
    val timestampNanos: Long,
    val userAcceleration: Vec3?,
    val rotationRate: Vec3?,
    val gravity: Vec3?,
    val attitude: AttitudePayload?,
)

/**
 * Bundles the four Android sensors into one sample. TYPE_LINEAR_ACCELERATION is the clock: a sample is emitted when
 * its event is at least 0.9 periods after the previous emission (thins devices that deliver faster than requested).
 * The other three contribute their most recent value unless it is older than 2.5 periods or absent, in which case
 * that group is omitted.
 */
class MotionAssembler(hz: Int, private val declinationRad: Double) {
    private val periodNanos = 1_000_000_000L / hz
    private val minSpacingNanos = periodNanos * 9 / 10
    private val maxAgeNanos = periodNanos * 5 / 2

    private var lastEmitNanos: Long? = null
    private var gravity: Pair<Long, Vec3>? = null
    private var gyro: Pair<Long, Vec3>? = null
    private var rotation: Pair<Long, FloatArray>? = null

    fun onGravity(timestampNanos: Long, values: FloatArray) {
        gravity = timestampNanos to MotionMath.toCoreMotionG(values)
    }

    fun onGyroscope(timestampNanos: Long, values: FloatArray) {
        gyro = timestampNanos to MotionMath.rotationRate(values)
    }

    fun onRotationVector(timestampNanos: Long, values: FloatArray) {
        rotation = timestampNanos to values.copyOf(minOf(values.size, 4))
    }

    fun onLinearAcceleration(timestampNanos: Long, values: FloatArray): MotionReading? {
        val last = lastEmitNanos
        if (last != null && timestampNanos - last < minSpacingNanos) return null
        lastEmitNanos = timestampNanos
        return MotionReading(
            timestampNanos = timestampNanos,
            userAcceleration = MotionMath.toCoreMotionG(values),
            rotationRate = fresh(gyro, timestampNanos),
            gravity = fresh(gravity, timestampNanos),
            attitude = fresh(rotation, timestampNanos)?.let { MotionMath.attitude(it, declinationRad) },
        )
    }

    private fun <T> fresh(value: Pair<Long, T>?, reference: Long): T? {
        value ?: return null
        val age = reference - value.first
        return if (age > maxAgeNanos) null else value.second
    }
}
