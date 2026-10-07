package hoshi.campustracker.sensors

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import hoshi.campustracker.core.CollectorClock
import hoshi.campustracker.core.L
import hoshi.campustracker.core.SensorTimestampCorrector
import hoshi.campustracker.core.finiteOrNull
import hoshi.campustracker.model.LocationCollectionProfile

private const val TAG = "Sensors"

/**
 * Set to true if indoor checks (§15.3) show ROTATION_VECTOR yaw jumps that disagree with the gyro: the
 * magnetometer-free GAME_ROTATION_VECTOR then becomes the first choice.
 */
const val PREFER_GAME_ROTATION_VECTOR = false

internal fun hasLocationPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

internal fun hasActivityRecognitionPermission(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED

/** Maps an Android fix to the iPhone field meanings (§4.1). Null when the coordinate itself is not finite. */
fun Location.toReading(clock: CollectorClock): LocationReading? {
    if (!latitude.isFinite() || !longitude.isFinite()) return null
    val msl = if (Build.VERSION.SDK_INT >= 34 && hasMslAltitude()) mslAltitudeMeters.finiteOrNull() else null
    return LocationReading(
        timestampMs = clock.epochMs(elapsedRealtimeNanos),
        latitude = latitude,
        longitude = longitude,
        altitude = msl,
        ellipsoidalAltitude = if (hasAltitude()) altitude.finiteOrNull() else null,
        horizontalAccuracy = if (hasAccuracy()) accuracy.finiteOrNull() else null,
        verticalAccuracy = if (hasVerticalAccuracy()) verticalAccuracyMeters.finiteOrNull() else null,
        speed = if (hasSpeed()) speed.finiteOrNull() else null,
        course = if (hasBearing()) bearing.finiteOrNull() else null,
        speedAccuracy = if (hasSpeedAccuracy()) speedAccuracyMetersPerSecond.finiteOrNull() else null,
        courseAccuracy = if (hasBearingAccuracy()) bearingAccuracyDegrees.finiteOrNull() else null,
    )
}

/** FusedLocationProviderClient (GNSS + Wi-Fi + cell, like CLLocationManager); LocationManager GPS without Play services. */
class AndroidLocationSource(
    private val context: Context,
    private val handler: Handler,
    private val clock: CollectorClock,
) : LocationSource {
    private val playServices: Boolean = runCatching {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }.getOrDefault(false)
    private val fused: FusedLocationProviderClient? = if (playServices) LocationServices.getFusedLocationProviderClient(context) else null
    private val locationManager = context.getSystemService(LocationManager::class.java)
    private var fusedCallback: LocationCallback? = null
    private var gpsListener: LocationListener? = null

    @Volatile override var isActive: Boolean = false
        private set

    override val providerLabel: String get() = if (fused != null) "fused" else "gps"

    @SuppressLint("MissingPermission")
    override fun start(profile: LocationCollectionProfile, distanceFilterMeters: Double, onLocation: (LocationReading) -> Unit): Boolean {
        if (isActive) return true
        if (!hasLocationPermission(context)) return false
        val distance = distanceFilterMeters.coerceIn(0.0, 100.0).toFloat()
        return try {
            if (fused != null) {
                val priority = if (profile == LocationCollectionProfile.batterySaving) Priority.PRIORITY_BALANCED_POWER_ACCURACY else Priority.PRIORITY_HIGH_ACCURACY
                val request = LocationRequest.Builder(priority, profile.intervalMs)
                    .setMinUpdateIntervalMillis(profile.intervalMs)
                    .setMinUpdateDistanceMeters(distance)
                    .setMaxUpdateDelayMillis(0)
                    .setWaitForAccurateLocation(false)
                    .build()
                val callback = object : LocationCallback() {
                    override fun onLocationResult(result: LocationResult) {
                        // All fixes, in order; nothing filtered (stale cached fixes too — the server decides).
                        for (location in result.locations) location.toReading(clock)?.let(onLocation)
                    }
                }
                fusedCallback = callback
                fused.requestLocationUpdates(request, callback, handler.looper)
            } else {
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        location.toReading(clock)?.let(onLocation)
                    }
                    override fun onLocationChanged(locations: MutableList<Location>) {
                        for (location in locations) location.toReading(clock)?.let(onLocation)
                    }
                    override fun onProviderEnabled(provider: String) = Unit
                    override fun onProviderDisabled(provider: String) = Unit
                    @Deprecated("Deprecated in Java")
                    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) = Unit
                }
                gpsListener = listener
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, profile.intervalMs, distance, listener, handler.looper)
            }
            isActive = true
            true
        } catch (e: SecurityException) {
            L.e(TAG, "location start failed: permission", e)
            false
        } catch (e: IllegalArgumentException) {
            L.e(TAG, "location start failed", e)
            false
        }
    }

    override fun stop() {
        fusedCallback?.let { fused?.removeLocationUpdates(it) }
        fusedCallback = null
        gpsListener?.let { locationManager.removeUpdates(it) }
        gpsListener = null
        isActive = false
    }

    @SuppressLint("MissingPermission")
    override fun lastKnownPosition(callback: (KnownPosition?) -> Unit) {
        if (!hasLocationPermission(context)) {
            handler.post { callback(null) }
            return
        }
        var delivered = false
        val deliver: (Location?) -> Unit = { location ->
            if (!delivered) {
                delivered = true
                callback(location?.let { KnownPosition(it.latitude, it.longitude, if (it.hasAltitude()) it.altitude else 0.0) })
            }
        }
        // Do not hold up Start for long: give up after 1.5 s and fall back to the magnetic-north frame.
        handler.postDelayed({ deliver(null) }, 1_500)
        try {
            if (fused != null) {
                fused.lastLocation
                    .addOnSuccessListener { location -> handler.post { deliver(location) } }
                    .addOnFailureListener { handler.post { deliver(null) } }
            } else {
                val location = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                    ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                handler.post { deliver(location) }
            }
        } catch (e: SecurityException) {
            handler.post { deliver(null) }
        }
    }
}

/** Four Android sensors bundled into one CMDeviceMotion-equivalent stream (§4.2). */
class AndroidMotionSource(
    context: Context,
    private val handler: Handler,
    private val clock: CollectorClock,
    private val corrector: SensorTimestampCorrector,
) : MotionSource {
    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val linear = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val gravity = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY)
    private val gyroscope = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val rotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val gameRotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    private var listener: SensorEventListener? = null

    @Volatile override var isActive: Boolean = false
        private set

    override val isAvailable: Boolean
        get() = linear != null && gravity != null && gyroscope != null && (rotationVector != null || gameRotationVector != null)

    override fun chooseAttitude(position: KnownPosition?, nowMs: Long): AttitudeChoice {
        if (rotationVector == null || (PREFER_GAME_ROTATION_VECTOR && gameRotationVector != null)) {
            return AttitudeChoice(AttitudeChoice.GAME_ROTATION_VECTOR, AttitudeChoice.ARBITRARY, null)
        }
        if (position == null) return AttitudeChoice(AttitudeChoice.ROTATION_VECTOR, AttitudeChoice.MAGNETIC_NORTH, null)
        val field = GeomagneticField(position.latitude.toFloat(), position.longitude.toFloat(), position.altitude.toFloat(), nowMs)
        return AttitudeChoice(AttitudeChoice.ROTATION_VECTOR, AttitudeChoice.TRUE_NORTH, field.declination.toDouble())
    }

    override fun start(
        hz: Int,
        attitude: AttitudeChoice,
        onReading: (MotionReading) -> Unit,
        onRotationAccuracyChanged: (Int) -> Unit,
        onClockOffset: (Long) -> Unit,
    ) {
        if (isActive || !isAvailable) return
        val attitudeSensor = if (attitude.sensor == AttitudeChoice.ROTATION_VECTOR) rotationVector else gameRotationVector
        val assembler = MotionAssembler(hz, if (attitude.referenceFrame == AttitudeChoice.TRUE_NORTH) attitude.declinationRad else 0.0)
        val l = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                corrector.calibrateIfNeeded(event.timestamp)?.let(onClockOffset)
                val ts = corrector.correct(event.timestamp)
                when (event.sensor.type) {
                    Sensor.TYPE_GRAVITY -> assembler.onGravity(ts, event.values)
                    Sensor.TYPE_GYROSCOPE -> assembler.onGyroscope(ts, event.values)
                    Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_GAME_ROTATION_VECTOR -> assembler.onRotationVector(ts, event.values)
                    Sensor.TYPE_LINEAR_ACCELERATION -> assembler.onLinearAcceleration(ts, event.values)?.let(onReading)
                }
            }

            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
                if (sensor.type == Sensor.TYPE_ROTATION_VECTOR) onRotationAccuracyChanged(accuracy)
            }
        }
        listener = l
        val periodUs = 1_000_000 / hz
        for (sensor in listOfNotNull(linear, gravity, gyroscope, attitudeSensor)) {
            if (!sensorManager.registerListener(l, sensor, periodUs, 0, handler)) {
                L.w(TAG, "registerListener failed sensor=${sensor.type}")
            }
        }
        isActive = true
    }

    override fun stop() {
        listener?.let { sensorManager.unregisterListener(it) }
        listener = null
        isActive = false
    }

    override fun epochMs(timestampNanos: Long): Long = clock.epochMs(timestampNanos)
}

/** TYPE_PRESSURE averaged into 1 s windows (§4.3). */
class AndroidAltimeterSource(
    context: Context,
    private val handler: Handler,
    private val clock: CollectorClock,
    private val corrector: SensorTimestampCorrector,
) : AltimeterSource {
    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val pressure = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE)
    private var listener: SensorEventListener? = null

    @Volatile override var isActive: Boolean = false
        private set

    override val isAvailable: Boolean get() = pressure != null

    override fun start(onReading: (AltimeterReading) -> Unit) {
        if (isActive || pressure == null) return
        val aggregator = BarometerAggregator()
        val l = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                aggregator.onPressure(corrector.correct(event.timestamp), event.values[0])?.let(onReading)
            }
            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
        }
        listener = l
        sensorManager.registerListener(l, pressure, SensorManager.SENSOR_DELAY_UI, 0, handler)
        isActive = true
    }

    override fun stop() {
        listener?.let { sensorManager.unregisterListener(it) }
        listener = null
        isActive = false
    }

    override fun epochMs(timestampNanos: Long): Long = clock.epochMs(timestampNanos)
}

/** TYPE_STEP_COUNTER → cumulative steps per run (§4.4). */
class AndroidPedometerSource(
    private val context: Context,
    private val handler: Handler,
    private val clock: CollectorClock,
    private val corrector: SensorTimestampCorrector,
) : PedometerSource {
    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val stepCounter = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    private var listener: SensorEventListener? = null

    @Volatile override var isActive: Boolean = false
        private set

    override val isAvailable: Boolean get() = stepCounter != null && hasActivityRecognitionPermission(context)

    override fun currentBootCount(): Int? =
        runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT) }.getOrNull()

    override fun start(
        restore: StepRestore?,
        onReading: (StepReading) -> Unit,
        onProgress: (baseline: Long?, lastTotal: Long) -> Unit,
        onError: (String) -> Unit,
    ): Boolean {
        if (isActive) return true
        val sensor = stepCounter ?: run { onError("SENSOR_UNAVAILABLE"); return false }
        if (!hasActivityRecognitionPermission(context)) {
            onError("PERMISSION_DENIED")
            return false
        }
        val tracker = StepCounterTracker(restore, currentBootCount())
        val l = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                val reading = tracker.onCounter(event.values[0].toLong(), clock.epochMs(corrector.correct(event.timestamp)))
                onProgress(tracker.baseline, tracker.lastTotal)
                reading?.let(onReading)
            }
            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
        }
        val ok = try {
            sensorManager.registerListener(l, sensor, SensorManager.SENSOR_DELAY_NORMAL, 0, handler)
        } catch (e: SecurityException) {
            L.e(TAG, "step counter registration rejected", e)
            false
        }
        if (!ok) {
            onError("REGISTER_FAILED")
            return false
        }
        listener = l
        isActive = true
        return true
    }

    override fun stop() {
        listener?.let { sensorManager.unregisterListener(it) }
        listener = null
        isActive = false
    }
}
