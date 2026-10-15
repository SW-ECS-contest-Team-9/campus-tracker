package hoshi.campustracker.positioning

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Handler
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import hoshi.campustracker.core.CollectorClock
import hoshi.campustracker.core.L

/**
 * BluetoothLeScanner implementation. Hardware-filtered (ScanFilter on the iBeacon prefix + proximity UUID) so the
 * stack keeps delivering with the screen off while the collection foreground service runs; low-latency mode because
 * positioning needs several advertisements per second. All callbacks are posted to [handler].
 *
 * Android limits apps to 5 scan starts per 30 s; restarts (Bluetooth toggled, registration failure) are spaced by
 * [MIN_RESTART_MS]. Background execution beyond the foreground service is not attempted.
 */
class AndroidBleBeaconScanner(
    private val context: Context,
    private val clock: CollectorClock,
    private val handler: Handler,
) : BeaconScanner, hoshi.campustracker.collection.SurveyScanner {
    companion object {
        private const val TAG = "BeaconScanner"
        const val MIN_RESTART_MS = 6_500L
    }

    override var state: BeaconScannerState = BeaconScannerState.Idle
        private set
    override var onStateChanged: ((BeaconScannerState) -> Unit)? = null

    private val normalizer = BeaconObservationNormalizer(clock::epochMs)
    private var uuids: Set<String> = emptySet()
    /** registration survey: every iBeacon, whatever its UUID (positioning scans never use this) */
    private var anyUuid = false
    private var listener: BeaconObservationListener? = null
    private var callback: ScanCallback? = null
    private var receiverRegistered = false
    private var lastStartMs = 0L
    private var rejected = 0L

    private val bluetoothReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON -> handler.post { if (listener != null) startScan() }
                BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> handler.post {
                    callback = null // the stack drops scans itself when Bluetooth goes off
                    setState(BeaconScannerState.BluetoothOff)
                }
            }
        }
    }

    override fun start(proximityUuids: Set<String>, listener: BeaconObservationListener) = begin(proximityUuids, false, listener)

    /** Every iBeacon in range (registration screen only): ScanFilter on the iBeacon prefix 0x02 0x15 alone. */
    override fun startSurvey(listener: BeaconObservationListener) = begin(emptySet(), true, listener)

    private fun begin(proximityUuids: Set<String>, any: Boolean, listener: BeaconObservationListener) {
        handler.post {
            this.anyUuid = any
            this.uuids = proximityUuids.map { it.lowercase() }.toSet()
            this.listener = listener
            if (!receiverRegistered) {
                ContextCompat.registerReceiver(context, bluetoothReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
                receiverRegistered = true
            }
            startScan()
        }
    }

    override fun stop() {
        handler.post {
            stopScan()
            listener = null
            if (receiverRegistered) {
                runCatching { context.unregisterReceiver(bluetoothReceiver) }
                receiverRegistered = false
            }
            setState(BeaconScannerState.Idle)
        }
    }

    @SuppressLint("MissingPermission") // checked just before every call
    private fun startScan() {
        stopScan()
        val missing = BeaconPermissions.missing({ ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED })
        if (missing.isNotEmpty()) return setState(BeaconScannerState.PermissionDenied(missing))
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        if (adapter == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return setState(BeaconScannerState.Unsupported)
        if (!adapter.isEnabled) return setState(BeaconScannerState.BluetoothOff)
        val location = context.getSystemService(LocationManager::class.java)
        if (BeaconPermissions.locationServicesRequired() && location != null && !LocationManagerCompat.isLocationEnabled(location)) {
            return setState(BeaconScannerState.LocationOff)
        }
        if (uuids.isEmpty() && !anyUuid) return setState(BeaconScannerState.NoRegisteredBeacons)
        val scanner = adapter.bluetoothLeScanner ?: return setState(BeaconScannerState.BluetoothOff)
        val wait = lastStartMs + MIN_RESTART_MS - SystemClock.elapsedRealtime()
        if (wait > 0) {
            handler.postDelayed({ if (listener != null && callback == null) startScan() }, wait)
            return
        }
        val filters = if (anyUuid) {
            val prefix = byteArrayOf(IBeaconParser.TYPE.toByte(), IBeaconParser.LENGTH.toByte())
            listOf(ScanFilter.Builder().setManufacturerData(IBeaconParser.APPLE_COMPANY_ID, prefix, byteArrayOf(-1, -1)).build())
        } else uuids.mapNotNull { uuid ->
            runCatching {
                val (data, mask) = IBeaconParser.filterFor(uuid)
                ScanFilter.Builder().setManufacturerData(IBeaconParser.APPLE_COMPANY_ID, data, mask).build()
            }.getOrNull()
        }
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setReportDelay(0)
            .build()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                handler.post { deliver(result) }
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                val copy = results.toList()
                handler.post { copy.forEach(::deliver) }
            }

            override fun onScanFailed(errorCode: Int) {
                handler.post { failed(errorCode) }
            }
        }
        lastStartMs = SystemClock.elapsedRealtime()
        try {
            scanner.startScan(filters, settings, cb)
            callback = cb
            setState(BeaconScannerState.Scanning(if (anyUuid) 0 else uuids.size))
            L.i(TAG, "scan started uuids=${uuids.size}")
        } catch (e: SecurityException) {
            setState(BeaconScannerState.PermissionDenied(BeaconPermissions.required()))
        } catch (e: IllegalStateException) {
            setState(BeaconScannerState.BluetoothOff) // adapter turned off between the check and the call
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        val cb = callback ?: return
        callback = null
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        runCatching { if (adapter?.isEnabled == true) adapter.bluetoothLeScanner?.stopScan(cb) }
    }

    private fun deliver(result: ScanResult) {
        val l = listener ?: return
        val data = result.scanRecord?.getManufacturerSpecificData(IBeaconParser.APPLE_COMPANY_ID)
        // result.timestampNanos: elapsedRealtimeNanos of the advertisement (the same clock as Location / SensorEvent)
        normalizer.normalize(IBeaconParser.APPLE_COMPANY_ID, data, result.rssi, result.timestampNanos, if (anyUuid) null else uuids)
            .onSuccess(l::onObservation)
            .onFailure { rejected++ }
    }

    private fun failed(code: Int) {
        val reason = when (code) {
            ScanCallback.SCAN_FAILED_ALREADY_STARTED -> return // our own scan is running
            ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "APPLICATION_REGISTRATION_FAILED"
            ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
            ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
            ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES -> "OUT_OF_HARDWARE_RESOURCES"
            ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY -> "SCANNING_TOO_FREQUENTLY"
            else -> "UNKNOWN"
        }
        L.w(TAG, "scan failed code=$code reason=$reason")
        callback = null
        setState(BeaconScannerState.Failed(code, reason))
        // transient stack errors: one spaced retry; unsupported hardware stays failed
        if (code != ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED) handler.postDelayed({ if (listener != null && callback == null) startScan() }, MIN_RESTART_MS)
    }

    private fun setState(s: BeaconScannerState) {
        if (s == state) return
        state = s
        onStateChanged?.invoke(s)
    }
}
