package hoshi.campustracker.collection

import hoshi.campustracker.net.AnchorBuilding
import hoshi.campustracker.net.ApiError
import hoshi.campustracker.positioning.AdminAnchor
import hoshi.campustracker.positioning.AdminBeacon
import hoshi.campustracker.positioning.AnchorPosition
import hoshi.campustracker.positioning.BeaconObservationListener
import hoshi.campustracker.positioning.BeaconScannerState
import hoshi.campustracker.positioning.IBeaconFrame
import hoshi.campustracker.positioning.beaconKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
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
    keys: Set<String> = emptySet(),
    var failWith: Exception? = null,
) : RegistrationBackend {
    val posted = mutableListOf<JsonObject>()
    val patches = mutableListOf<Pair<String, JsonObject>>()
    val beacons = keys.mapIndexed { i, k ->
        val (_, uuid, major, minor) = k.split(":")
        AdminBeacon("b$i", uuid, major.toInt(), minor.toInt())
    }.toMutableList()
    override fun canRegister(): Boolean = allowed
    override fun beacons(): List<AdminBeacon> = beacons.toList()
    override fun register(body: JsonObject): String {
        failWith?.let { throw it }
        posted += body
        beacons += AdminBeacon("b${beacons.size}", body["uuid"]!!.jsonPrimitive.content, body["major"]!!.jsonPrimitive.content.toInt(),
            body["minor"]!!.jsonPrimitive.content.toInt())
        return "ok"
    }
    override fun update(beaconId: String, body: JsonObject): AdminBeacon {
        failWith?.let { throw it }
        patches += beaconId to body
        val i = beacons.indexOfFirst { it.beaconId == beaconId }
        if (i < 0) throw ApiError.Http(404, "BEACON_NOT_FOUND", null)
        val b = beacons[i]
        val label = body["label"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content } ?: if ("label" in body) null else b.label
        val updated = b.copy(label = label, enabled = body["enabled"]?.jsonPrimitive?.boolean ?: b.enabled,
            anchor = body["anchor"]?.jsonObject?.let { a ->
                val p = a["position"]!!.jsonObject
                AdminAnchor("a$i", a["buildingId"]!!.jsonPrimitive.content, position = AnchorPosition(p["x"]!!.jsonPrimitive.double,
                    p["y"]!!.jsonPrimitive.double, p["z"]!!.jsonPrimitive.double))
            } ?: if ("anchorId" in body) null else b.anchor)
        beacons[i] = updated
        return updated
    }
    override fun delete(beaconId: String) {
        if (!beacons.removeIf { it.beaconId == beaconId }) throw ApiError.Http(404, "BEACON_NOT_FOUND", null)
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
        val backend = FakeBackend(keys = setOf(beaconKey(uuid, 1, 1)))
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

    @Test
    fun editDisableDelete() {
        val backend = FakeBackend(keys = setOf(beaconKey(uuid, 1, 1), beaconKey(uuid, 1, 2)))
        var refreshed = 0
        val c = controller(backend) { refreshed++ }
        c.open()
        assertEquals(2, c.ui.value.registered.size)
        val target = c.ui.value.registered.first { it.minor == 2 }

        c.startEdit(target)
        assertEquals(target, c.ui.value.editing)
        assertEquals("2", c.ui.value.form.minor)
        // save: label + grid placement; identity is not sent
        c.edit { it.copy(label = "hall door", buildingId = "B07", positionMode = "grid", x = "201100", y = "557250", z = "154.5") }
        c.submit()
        val (id, body) = backend.patches.last()
        assertEquals(target.beaconId, id)
        assertFalse("uuid" in body)
        assertEquals("hall door", c.ui.value.editing?.label)
        assertEquals("201100", c.ui.value.form.x)
        assertEquals(1, refreshed)
        assertEquals("hall door", c.ui.value.registered.first { it.minor == 2 }.label)
        // invalid edit: field errors, nothing sent
        c.edit { it.copy(floor = "5G") }
        c.submit()
        assertTrue("floor" in c.ui.value.errors)
        assertEquals(1, backend.patches.size)
        c.edit { it.copy(floor = "") }

        c.setEnabled(false)
        assertEquals(false, c.ui.value.editing?.enabled)
        assertEquals(false, backend.patches.last().second["enabled"]!!.jsonPrimitive.boolean)
        assertEquals(2, refreshed)

        c.delete()
        assertNull(c.ui.value.editing)
        assertEquals(listOf(1), c.ui.value.registered.map { it.minor })
        assertEquals("", c.ui.value.form.uuid)
        assertTrue(c.ui.value.message!!.startsWith("삭제했습니다"))
        assertEquals(3, refreshed)
    }

    @Test
    fun editOfABeaconDeletedElsewhereReturnsToNew() {
        val backend = FakeBackend(keys = setOf(beaconKey(uuid, 1, 1)))
        val c = controller(backend)
        c.open()
        c.startEdit(c.ui.value.registered.single())
        backend.beacons.clear()
        c.submit()
        assertEquals("이미 삭제된 비콘입니다.", c.ui.value.message)
        assertNull(c.ui.value.editing)
        assertTrue(c.ui.value.registered.isEmpty())
    }

    @Test
    fun pickLeavesEditMode() {
        val backend = FakeBackend(keys = setOf(beaconKey(uuid, 1, 1)))
        val c = controller(backend)
        c.open()
        c.startEdit(c.ui.value.registered.single())
        c.record(IBeaconFrame(uuid, 1, 5, -60), -50)
        c.pick(c.ui.value.heard.first { it.minor == 5 })
        assertNull(c.ui.value.editing)
        assertEquals("5", c.ui.value.form.minor)
    }
}
