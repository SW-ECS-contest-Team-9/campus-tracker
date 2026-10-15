package hoshi.campustracker.positioning

import android.Manifest
import android.app.Application
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import hoshi.campustracker.core.CollectorClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidBleBeaconScannerTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val clock = object : CollectorClock {
        override fun nowMs() = 0L
        override fun epochMs(elapsedRealtimeNanos: Long) = elapsedRealtimeNanos / 1_000_000
        override fun elapsedRealtimeNanos() = 0L
    }
    private val uuids = setOf("e2c56db5-dffb-48d2-b060-d0f5a71096e0")

    private fun scanner(): Pair<AndroidBleBeaconScanner, MutableList<BeaconScannerState>> {
        val s = AndroidBleBeaconScanner(app, clock, Handler(Looper.getMainLooper()))
        val states = mutableListOf<BeaconScannerState>()
        s.onStateChanged = { states += it }
        return s to states
    }

    @Test
    fun permissionDeniedIsAStateNotACrash() {
        shadowOf(app).denyPermissions(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.ACCESS_FINE_LOCATION)
        val (s, states) = scanner()
        s.start(uuids) { }
        shadowOf(Looper.getMainLooper()).idle()
        val denied = states.last() as BeaconScannerState.PermissionDenied
        assertTrue(Manifest.permission.BLUETOOTH_SCAN in denied.missing)
        s.stop()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(BeaconScannerState.Idle, s.state)
    }

    @Test
    fun bluetoothOffIsReportedAndNothingIsScanned() {
        shadowOf(app).grantPermissions(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.ACCESS_FINE_LOCATION)
        val adapter = app.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        @Suppress("DEPRECATION") adapter.adapter.disable()
        shadowOf(adapter.adapter).setEnabled(false)
        val (s, states) = scanner()
        s.start(uuids) { }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(states.toString(), states.last() is BeaconScannerState.BluetoothOff || states.last() is BeaconScannerState.Unsupported)
        s.stop()
    }
}
