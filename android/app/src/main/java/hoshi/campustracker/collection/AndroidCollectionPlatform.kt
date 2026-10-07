package hoshi.campustracker.collection

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.location.LocationManagerCompat
import hoshi.campustracker.model.SensorCapabilities
import hoshi.campustracker.sensors.AltimeterSource
import hoshi.campustracker.sensors.AttitudeChoice
import hoshi.campustracker.sensors.MotionSource
import hoshi.campustracker.sensors.PedometerSource

class HandlerExecutor(private val handler: Handler) : SerialExecutor {
    override fun post(block: () -> Unit) {
        handler.post(block)
    }

    override fun postDelayed(delayMs: Long, block: () -> Unit) {
        handler.postDelayed(block, delayMs)
    }
}

/** Remembers whether the location permission was ever requested (to tell `notDetermined` from `denied`). */
class PermissionHistory(context: Context) {
    private val prefs = context.getSharedPreferences("campus_collector_permissions", Context.MODE_PRIVATE)
    var locationRequested: Boolean
        get() = prefs.getBoolean("locationRequested", false)
        set(value) = prefs.edit { putBoolean("locationRequested", value) }
}

class AndroidCollectionPlatform(
    private val context: Context,
    private val motion: MotionSource,
    private val altimeter: AltimeterSource,
    private val pedometer: PedometerSource,
    private val permissions: PermissionHistory,
) : CollectionPlatform {
    private fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    override fun capabilities(attitude: AttitudeChoice?, motionHz: Int, locationProvider: String): SensorCapabilities {
        val locationManager = context.getSystemService(LocationManager::class.java)
        val fine = granted(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        return SensorCapabilities(
            locationAvailable = LocationManagerCompat.isLocationEnabled(locationManager),
            deviceMotionAvailable = motion.isAvailable,
            altimeterAvailable = altimeter.isAvailable,
            stepCountingAvailable = pedometer.isAvailable,
            distanceAvailable = false,
            floorCountingAvailable = false,
            paceAvailable = false,
            cadenceAvailable = false,
            attitudeReferenceFrame = attitude?.referenceFrame,
            motionUpdateHz = motionHz,
            locationAuthorization = locationAuthorizationLabel(),
            locationAccuracyAuthorization = when {
                fine -> "fullAccuracy"
                coarse -> "reducedAccuracy"
                else -> null
            },
            backgroundLocationUpdates = true,
            pausesLocationUpdatesAutomatically = false,
            attitudeSensor = attitude?.sensor,
            magneticDeclinationDeg = attitude?.declinationDeg,
            locationProvider = locationProvider,
            motionConvention = SensorCapabilities.MOTION_CONVENTION,
        )
    }

    override fun locationAuthorizationLabel(): String {
        val any = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        return when {
            any && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> "authorizedAlways"
            any -> "authorizedWhenInUse"
            !permissions.locationRequested -> "notDetermined"
            else -> "denied"
        }
    }

    override fun isPowerSaveMode(): Boolean = context.getSystemService(PowerManager::class.java).isPowerSaveMode

    override fun startForegroundCollection() = CollectionService.start(context)
    override fun stopForegroundCollection() = CollectionService.stop(context)
}
