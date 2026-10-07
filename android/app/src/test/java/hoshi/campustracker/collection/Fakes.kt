package hoshi.campustracker.collection

import hoshi.campustracker.core.CollectorClock
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.SensorCapabilities
import hoshi.campustracker.sensors.AltimeterReading
import hoshi.campustracker.sensors.AltimeterSource
import hoshi.campustracker.sensors.AttitudeChoice
import hoshi.campustracker.sensors.KnownPosition
import hoshi.campustracker.sensors.LocationReading
import hoshi.campustracker.sensors.LocationSource
import hoshi.campustracker.sensors.MotionReading
import hoshi.campustracker.sensors.MotionSource
import hoshi.campustracker.sensors.PedometerSource
import hoshi.campustracker.sensors.StepReading
import hoshi.campustracker.sensors.StepRestore

class FakeClock(var now: Long = 1_791_352_800_000L) : CollectorClock {
    override fun nowMs() = now
    override fun epochMs(elapsedRealtimeNanos: Long) = elapsedRealtimeNanos / 1_000_000
    override fun elapsedRealtimeNanos() = now * 1_000_000
}

/** Runs posted blocks on demand; delayed blocks run when [advance] passes their time. */
class ManualExecutor(private val clock: FakeClock) : SerialExecutor {
    private val queue = ArrayDeque<() -> Unit>()
    private val delayed = mutableListOf<Pair<Long, () -> Unit>>()

    override fun post(block: () -> Unit) { queue.addLast(block) }
    override fun postDelayed(delayMs: Long, block: () -> Unit) { delayed += (clock.now + delayMs) to block }

    fun runAll() {
        while (queue.isNotEmpty()) queue.removeFirst().invoke()
    }

    fun advance(ms: Long) {
        val target = clock.now + ms
        while (true) {
            runAll()
            val next = delayed.filter { it.first <= target }.minByOrNull { it.first } ?: break
            delayed.remove(next)
            clock.now = maxOf(clock.now, next.first)
            next.second()
        }
        clock.now = target
        runAll()
    }
}

class FakeLocation : LocationSource {
    override var isActive = false
    override val providerLabel = "fused"
    var callback: ((LocationReading) -> Unit)? = null
    override fun start(profile: LocationCollectionProfile, distanceFilterMeters: Double, onLocation: (LocationReading) -> Unit): Boolean {
        isActive = true; callback = onLocation; return true
    }
    override fun stop() { isActive = false; callback = null }
    override fun lastKnownPosition(callback: (KnownPosition?) -> Unit) = callback(KnownPosition(37.61, 127.01, 80.0))
    fun emit(ts: Long, lat: Double = 37.61, lon: Double = 127.01) =
        callback!!(LocationReading(ts, lat, lon, 82.4, 105.0, 4.8, 3.1, 1.3, 271.0, 0.4, 12.0))
}

class FakeMotion : MotionSource {
    override val isAvailable = true
    override var isActive = false
    var callback: ((MotionReading) -> Unit)? = null
    var startedWith: AttitudeChoice? = null
    override fun chooseAttitude(position: KnownPosition?, nowMs: Long) =
        AttitudeChoice(AttitudeChoice.ROTATION_VECTOR, AttitudeChoice.TRUE_NORTH, -8.7)
    override fun start(hz: Int, attitude: AttitudeChoice, onReading: (MotionReading) -> Unit, onRotationAccuracyChanged: (Int) -> Unit, onClockOffset: (Long) -> Unit) {
        isActive = true; callback = onReading; startedWith = attitude
    }
    override fun stop() { isActive = false; callback = null }
    override fun epochMs(timestampNanos: Long) = timestampNanos / 1_000_000
    fun emit(tsMs: Long) = callback!!(MotionReading(tsMs * 1_000_000, null, null, null, null))
}

/** A device without a barometer. */
class FakeAltimeter : AltimeterSource {
    override val isAvailable = false
    override var isActive = false
    override fun start(onReading: (AltimeterReading) -> Unit) { isActive = true }
    override fun stop() { isActive = false }
    override fun epochMs(timestampNanos: Long) = timestampNanos / 1_000_000
}

class FakePedometer : PedometerSource {
    override val isAvailable = true
    override var isActive = false
    var restore: StepRestore? = null
    var callback: ((StepReading) -> Unit)? = null
    override fun currentBootCount() = 3
    override fun start(restore: StepRestore?, onReading: (StepReading) -> Unit, onProgress: (Long?, Long) -> Unit, onError: (String) -> Unit): Boolean {
        this.restore = restore; isActive = true; callback = onReading
        onProgress(1_000, restore?.lastTotal ?: 0)
        return true
    }
    override fun stop() { isActive = false; callback = null }
}

class FakePlatform(private val motion: MotionSource, private val altimeter: AltimeterSource, private val pedometer: PedometerSource) : CollectionPlatform {
    var foreground = false
    override fun capabilities(attitude: AttitudeChoice?, motionHz: Int, locationProvider: String) = SensorCapabilities(
        locationAvailable = true, deviceMotionAvailable = motion.isAvailable, altimeterAvailable = altimeter.isAvailable,
        stepCountingAvailable = pedometer.isAvailable, attitudeReferenceFrame = attitude?.referenceFrame, motionUpdateHz = motionHz,
        locationAuthorization = "authorizedWhenInUse", attitudeSensor = attitude?.sensor, magneticDeclinationDeg = attitude?.declinationDeg,
        locationProvider = locationProvider, motionConvention = SensorCapabilities.MOTION_CONVENTION,
    )
    override fun locationAuthorizationLabel() = "authorizedWhenInUse"
    override fun isPowerSaveMode() = false
    override fun startForegroundCollection() { foreground = true }
    override fun stopForegroundCollection() { foreground = false }
}
