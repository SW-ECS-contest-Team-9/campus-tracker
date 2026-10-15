package hoshi.campustracker.positioning

import android.Manifest
import android.annotation.SuppressLint
import android.os.Build

/** Scanner state as the app shows it. Every non-[Scanning] state means "no beacons now"; fusion goes on without them. */
sealed class BeaconScannerState {
    data object Idle : BeaconScannerState()
    data class Scanning(val uuids: Int) : BeaconScannerState()
    data object BluetoothOff : BeaconScannerState()
    data object LocationOff : BeaconScannerState()
    data class PermissionDenied(val missing: List<String>) : BeaconScannerState()
    data object Unsupported : BeaconScannerState()
    /** nothing registered to scan for (no config yet, or the server lists no beacons) */
    data object NoRegisteredBeacons : BeaconScannerState()
    data class Failed(val code: Int, val reason: String) : BeaconScannerState()
}

fun interface BeaconObservationListener {
    fun onObservation(observation: BeaconObservation)
}

/**
 * Platform scanner contract (shared by the collector and a future navigator). Implementations deliver only iBeacon
 * observations of the given proximity UUIDs: arbitrary BLE devices and MAC addresses never become anchors.
 */
interface BeaconScanner {
    val state: BeaconScannerState
    fun start(proximityUuids: Set<String>, listener: BeaconObservationListener)
    fun stop()
    var onStateChanged: ((BeaconScannerState) -> Unit)?
}

/**
 * Runtime permissions for BLE positioning. The scan results ARE used to derive location, so BLUETOOTH_SCAN is declared
 * without `neverForLocation` and fine location is required on every version (Android filters iBeacon results out
 * otherwise). Android <= 11: BLUETOOTH / BLUETOOTH_ADMIN are install-time permissions (manifest, maxSdkVersion 30).
 */
object BeaconPermissions {
    /** A string constant; only requested on API 31+ (see [required]). */
    @SuppressLint("InlinedApi")
    const val BLUETOOTH_SCAN: String = Manifest.permission.BLUETOOTH_SCAN

    fun required(sdkInt: Int = Build.VERSION.SDK_INT): List<String> =
        if (sdkInt >= Build.VERSION_CODES.S) listOf(BLUETOOTH_SCAN, Manifest.permission.ACCESS_FINE_LOCATION)
        else listOf(Manifest.permission.ACCESS_FINE_LOCATION)

    fun missing(granted: (String) -> Boolean, sdkInt: Int = Build.VERSION.SDK_INT): List<String> = required(sdkInt).filterNot(granted)

    /**
     * Location services must be on for BLE scan results unless the app opted out of location with neverForLocation,
     * which this app must not do.
     */
    fun locationServicesRequired(@Suppress("UNUSED_PARAMETER") sdkInt: Int = Build.VERSION.SDK_INT): Boolean = true
}
