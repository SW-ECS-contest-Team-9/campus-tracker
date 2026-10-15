package hoshi.campustracker.collection

import hoshi.campustracker.net.AnchorBuilding
import hoshi.campustracker.net.ApiError
import hoshi.campustracker.positioning.BeaconObservationListener
import hoshi.campustracker.positioning.BeaconScannerState
import hoshi.campustracker.positioning.IBeaconFrame
import hoshi.campustracker.positioning.beaconKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeSurveyScanner : SurveyScanner {
    override var state: BeaconScannerState = BeaconScannerState.Idle
    override var onStateChanged: ((BeaconScannerState) -> Unit)? = null
    var listener: BeaconObservationListener? = null
    override fun startSurvey(listener: BeaconObservationListener) {
        this.listener = listener
        state = BeaconScannerState.Scanning(0)
        onStateChanged?.invoke(state)
    }
    override fun stop() {
        listener = null
        state = BeaconScannerState.Idle
        onStateChanged?.invoke(state)
    }
}

private class FakeBackend(
    var allowed: Boolean = true,
    val keys: MutableSet<String> = mutableSetOf(),
    var failWith: Exception? = null,
) : RegistrationBackend {
    val posted = mutableListOf<JsonObject>()
    override fun canRegister(): Boolean = allowed
    override fun registeredKeys(): Set<String> = keys.toSet()
    override fun register(body: JsonObject): String {
        failWith?.let { throw it }
        posted += body
        return "ok"
    }
    override fun buildings() = listOf(AnchorBuilding("B07", "Library"))
}

class BeaconRegistrationControllerTest {
    private val uuid = "e2c56db5-dffb-48d2-b060-d0f5a71096e0"
    // Unconfined: every launch runs to completion inline, so the tests read the state right after each call
    private fun controller(backend: FakeBackend, scanner: FakeSurveyScanner = FakeSurveyScanner(), fix: GeoFix? = null, onRegistered: () -> Unit = {}) =
        BeaconRegistrationController(scanner, backend, { fix }, CoroutineScope(Dispatchers.Unconfined), { 1_000L }, onRegistered)

    @Test
    fun deniedAccountCannotRegister() {
        val c = controller(FakeBackend(allowed = false))
        c.open()
        assertEquals(RegistrationAccess.DENIED, c.ui.value.access)
        val signedOut = object : RegistrationBackend by FakeBackend() {
            override fun canRegister(): Boolean = throw ApiError.Http(401, "UNAUTHORIZED", null)
        }
        val c2 = BeaconRegistrationController(FakeSurveyScanner(), signedOut, { null }, CoroutineScope(Dispatchers.Unconfined), { 0L })
        c2.open()
        assertEquals(RegistrationAccess.SIGNED_OUT, c2.ui.value.access)
    }

    @Test
    fun scanPickLocateSubmit() {
        val backend = FakeBackend(keys = mutableSetOf(beaconKey(uuid, 1, 1)))
        val scanner = FakeSurveyScanner()
        var refreshed = 0
        val c = controller(backend, scanner, GeoFix(37.6105, 126.9971, 4.0)) { refreshed++ }
        c.open()
        assertEquals(RegistrationAccess.ALLOWED, c.ui.value.access)
        assertEquals("B07", c.ui.value.buildings.single().buildingId)
        c.startScan()
        assertTrue(c.ui.value.scanning)
        assertTrue(c.ui.value.scanner is BeaconScannerState.Scanning)
        c.record(IBeaconFrame(uuid, 1, 1, -59), -40)
        c.record(IBeaconFrame(uuid, 1, 7, -61), -55)
        val heard = c.ui.value.heard
        assertEquals(listOf(7, 1), heard.map { it.minor }) // unregistered first
        assertTrue(heard[1].registered)

        c.pick(heard[0])
        assertEquals(uuid.uppercase(), c.ui.value.form.uuid)
        assertEquals("7", c.ui.value.form.minor)
        assertEquals("-61", c.ui.value.form.measuredPowerDbm)
        c.useCurrentLocation()
        assertEquals("37.6105000", c.ui.value.form.latitude)
        assertEquals("4", c.ui.value.form.horizontalAccuracyM)

        // anchor wanted but no building / height yet -> field errors, nothing posted
        c.submit()
        assertTrue(c.ui.value.errors.keys.containsAll(listOf("buildingId", "z")))
        assertTrue(backend.posted.isEmpty())

        c.edit { it.copy(buildingId = "B07", floor = "3F", floorHeightM = "148.2", mountAboveFloorM = "2.5") }
        c.submit()
        assertTrue(c.ui.value.errors.isEmpty())
        val body = backend.posted.single()
        assertEquals(7, body["minor"]!!.jsonPrimitive.content.toInt())
        assertEquals(150.7, body["anchor"]!!.jsonObject["position"]!!.jsonObject["z"]!!.jsonPrimitive.content.toDouble(), 1e-9)
        assertEquals(1, refreshed)
        assertFalse(c.ui.value.submitting)
        assertTrue(c.ui.value.heard.all { it.registered }) // the new beacon is marked registered in the list

        c.close()
        assertFalse(c.ui.value.scanning)
        assertNull(scanner.listener)
    }

    @Test
    fun duplicateIsExplained() {
        val backend = FakeBackend(failWith = ApiError.Http(409, "BEACON_EXISTS", "exists"))
        var refreshed = 0
        val c = controller(backend) { refreshed++ }
        c.open()
        c.edit { it.copy(uuid = uuid, major = "1", minor = "2") }
        c.submit()
        assertNotNull(c.ui.value.message)
        assertTrue(c.ui.value.message!!.contains("이미 등록"))
        assertEquals(0, refreshed)
    }

    @Test
    fun locationFailureKeepsForm() {
        val c = controller(FakeBackend(), fix = null)
        c.edit { it.copy(latitude = "37.1") }
        c.useCurrentLocation()
        assertEquals("37.1", c.ui.value.form.latitude)
        assertTrue(c.ui.value.message!!.contains("위치를 읽지 못했습니다"))
    }
}
