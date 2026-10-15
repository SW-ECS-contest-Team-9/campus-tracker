package hoshi.campustracker.positioning

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BeaconRegistrationTest {
    private fun fixture(): JsonObject {
        val name = "registration-cases.json"
        val file = listOf(File("../../fixtures/beacon/$name"), File("../fixtures/beacon/$name"), File("fixtures/beacon/$name")).first { it.exists() }
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    /** JSON equality with numbers compared numerically (148.2 == 148.2, 1 == 1.0). */
    private fun same(a: JsonElement, b: JsonElement): Boolean = when {
        a is JsonObject && b is JsonObject -> a.keys == b.keys && a.keys.all { same(a[it]!!, b[it]!!) }
        a is JsonNull || b is JsonNull -> a == b
        a is JsonPrimitive && b is JsonPrimitive && !a.isString && !b.isString && a.booleanOrNull == null && b.booleanOrNull == null ->
            a.doubleOrNull == b.doubleOrNull
        else -> a == b
    }

    @Test
    fun sharedCases() {
        val cases = fixture()["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 7)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            val form = Json { ignoreUnknownKeys = true }.decodeFromJsonElement(FormDto.serializer(), c["form"]!!).toForm()
            val r = BeaconRegistration.build(form)
            val body = c["body"]
            if (body != null) {
                if (r !is RegistrationRequest.Body) fail("$name: expected body, got $r")
                r as RegistrationRequest.Body
                assertTrue("$name: ${r.json} != $body", same(r.json, body))
            } else {
                if (r !is RegistrationRequest.Errors) fail("$name: expected errors, got $r")
                val expected = c["errors"]!!.jsonArray.map { it.jsonPrimitive.content }.sorted()
                assertEquals(name, expected, (r as RegistrationRequest.Errors).fields.keys.sorted())
            }
        }
    }

    @Test
    fun sharedEditCases() {
        val fx = fixture()
        val cases = fx["editCases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 3)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            val form = Json { ignoreUnknownKeys = true }.decodeFromJsonElement(FormDto.serializer(), c["form"]!!).toForm()
            val r = BeaconRegistration.buildEdit(form)
            val body = c["body"]
            if (body != null) {
                if (r !is RegistrationRequest.Body) fail("$name: expected body, got $r")
                assertTrue("$name: ${(r as RegistrationRequest.Body).json} != $body", same(r.json, body))
            } else {
                if (r !is RegistrationRequest.Errors) fail("$name: expected errors, got $r")
                assertEquals(name, c["errors"]!!.jsonArray.map { it.jsonPrimitive.content }.sorted(), (r as RegistrationRequest.Errors).fields.keys.sorted())
            }
        }
        val json = Json { ignoreUnknownKeys = true }
        for (c in fx["beaconToForm"]!!.jsonArray.map { it.jsonObject }) {
            val beacon = json.decodeFromJsonElement(AdminBeacon.serializer(), c["beacon"]!!)
            val expected = json.decodeFromJsonElement(FormDto.serializer(), c["form"]!!).toForm()
            assertEquals(c["name"]!!.jsonPrimitive.content, expected, BeaconRegistration.formFrom(beacon))
            // the opened form saves without errors
            assertTrue(BeaconRegistration.buildEdit(expected) is RegistrationRequest.Body)
        }
    }

    @Test
    fun uuidNormalization() {
        assertEquals("e2c56db5-dffb-48d2-b060-d0f5a71096e0", BeaconRegistration.normalizeUuid(" E2C56DB5-DFFB-48D2-B060-D0F5A71096E0 "))
        assertNull(BeaconRegistration.normalizeUuid("xyz"))
        assertNull(BeaconRegistration.normalizeUuid("e2c56db5dffb48d2b060d0f5a71096e"))
    }

    @Test
    fun heardListOrdersAndReevaluatesRegistration() {
        val known = mutableSetOf<String>()
        val heard = HeardBeacons { it in known }
        val uuid = "e2c56db5-dffb-48d2-b060-d0f5a71096e0"
        heard.add(IBeaconFrame(uuid, 1, 1, -59), -50, 1)
        heard.add(IBeaconFrame(uuid, 1, 2, -59), -80, 2)
        heard.add(IBeaconFrame(uuid, 1, 3, -59), -70, 3)
        heard.add(IBeaconFrame(uuid, 1, 2, -61), 127, 4) // unusable RSSI: counted, value ignored
        known += beaconKey(uuid, 1, 1)
        val rows = heard.list()
        assertEquals(listOf(3, 2, 1), rows.map { it.minor })
        assertEquals(2, rows[1].count)
        assertEquals(-80, rows[1].maxRssi)
        assertEquals(-61, rows[1].measuredPower)
        assertTrue(rows[2].registered)
        assertFalse(rows[0].registered)
        heard.clear()
        assertTrue(heard.list().isEmpty())
    }
}

@kotlinx.serialization.Serializable
private data class FormDto(
    val uuid: String = "", val major: String = "", val minor: String = "", val measuredPowerDbm: String = "", val label: String = "",
    val buildingId: String = "", val floor: String = "", val floorHeightM: String = "", val mountAboveFloorM: String = "",
    val positionMode: String = "wgs84", val latitude: String = "", val longitude: String = "", val x: String = "", val y: String = "",
    val z: String = "", val horizontalAccuracyM: String = "",
) {
    fun toForm() = BeaconRegistrationForm(uuid, major, minor, measuredPowerDbm, label, buildingId, floor, floorHeightM, mountAboveFloorM,
        positionMode, latitude, longitude, x, y, z, horizontalAccuracyM)
}
