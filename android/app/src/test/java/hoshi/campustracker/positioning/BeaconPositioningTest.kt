package hoshi.campustracker.positioning

import android.Manifest
import hoshi.campustracker.core.AppJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Shared fixtures (fixtures/beacon) are read by the server, Android and iOS tests alike. */
private fun fixture(name: String): JsonObject {
    val candidates = listOf(File("../../fixtures/beacon/$name"), File("../fixtures/beacon/$name"), File("fixtures/beacon/$name"))
    val file = candidates.first { it.exists() }
    return Json.parseToJsonElement(file.readText()).jsonObject
}

class IBeaconParserTest {
    @Test
    fun sharedPacketFixture() {
        val cases = fixture("ibeacon-packets.json")["cases"]!!.jsonArray
        assertTrue(cases.size >= 9)
        for (c in cases.map { it.jsonObject }) {
            val name = c["name"]!!.jsonPrimitive.content
            val frame = IBeaconParser.parse(c["manufacturerId"]!!.jsonPrimitive.int, IBeaconParser.hexToBytes(c["data"]!!.jsonPrimitive.content))
            val expected = c["expected"]
            if (expected == null || expected is JsonNull) {
                assertNull(name, frame)
            } else {
                val e = expected.jsonObject
                assertNotNull(name, frame)
                assertEquals(name, e["uuid"]!!.jsonPrimitive.content, frame!!.uuid)
                assertEquals(name, e["major"]!!.jsonPrimitive.int, frame.major)
                assertEquals(name, e["minor"]!!.jsonPrimitive.int, frame.minor)
                assertEquals(name, e["measuredPower"]!!.jsonPrimitive.int, frame.measuredPowerDbm)
            }
        }
    }

    @Test
    fun bigEndianAndSignedPower() {
        val (data, _) = IBeaconParser.filterFor("E2C56DB5-DFFB-48D2-B060-D0F5A71096E0")
        data[18] = 0x01; data[19] = 0x02; data[20] = 0xFF.toByte(); data[21] = 0xFE.toByte(); data[22] = 0xC5.toByte()
        val f = IBeaconParser.parse(0x004C, data)!!
        assertEquals(0x0102, f.major)
        assertEquals(0xFFFE, f.minor)
        assertEquals(-59, f.measuredPowerDbm)
        assertEquals("IBEACON:e2c56db5-dffb-48d2-b060-d0f5a71096e0:258:65534", f.key)
    }

    @Test
    fun scanFilterMatchesPrefixAndUuidOnly() {
        val (data, mask) = IBeaconParser.filterFor("e2c56db5-dffb-48d2-b060-d0f5a71096e0")
        assertEquals(23, data.size)
        assertEquals(0x02, data[0].toInt())
        assertEquals(0x15, data[1].toInt())
        assertTrue((0 until 18).all { mask[it] == 0xFF.toByte() })
        assertTrue((18 until 23).all { mask[it] == 0.toByte() }) // any major / minor / power
    }

    @Test
    fun malformedPacketsAreSafe() {
        assertNull(IBeaconParser.parse(0x004C, null))
        assertNull(IBeaconParser.parse(0x004C, ByteArray(0)))
        assertNull(IBeaconParser.parse(0x004C, ByteArray(22) { 0x02 }))
        assertNull(IBeaconParser.parse(0x0059, IBeaconParser.filterFor("e2c56db5-dffb-48d2-b060-d0f5a71096e0").first))
    }
}

class BeaconMeasurementTest {
    @Test
    fun sharedModelFixture() {
        val f = fixture("measurement-model.json")
        val d = f["defaults"]!!.jsonObject
        assertEquals(RssiModel.DEFAULTS.measuredPower1m, d["measuredPower1m"]!!.jsonPrimitive.double, 0.0)
        assertEquals(RssiModel.DEFAULTS.pathLossExponent, d["pathLossExponent"]!!.jsonPrimitive.double, 0.0)
        for (c in f["modelCases"]!!.jsonArray.map { it.jsonObject }) {
            val m = RssiModel(c["measuredPower1m"]!!.jsonPrimitive.double, c["pathLossExponent"]!!.jsonPrimitive.double, c["rssiVariance"]!!.jsonPrimitive.double, "T")
            assertEquals(c["expectedRangeM"]!!.jsonPrimitive.double, m.range(c["rssi"]!!.jsonPrimitive.double), 1e-5)
            assertEquals(c["expectedLnSigma"]!!.jsonPrimitive.double, m.lnRangeSigma, 1e-5)
        }
        val rows = f["calibrationRows"]!!.jsonArray.map { AppJson.decodeFromJsonElement(BeaconCalibration.serializer(), it) }
        for (c in f["selectionCases"]!!.jsonArray.map { it.jsonObject }) {
            val m = RssiModel.select(rows, c["beaconId"]!!.jsonPrimitive.content, c["platform"]!!.jsonPrimitive.content,
                c["deviceModel"]!!.jsonPrimitive.content, c["advertised"]?.jsonPrimitive?.intOrNull)
            assertEquals(c.toString(), c["expectedSource"]!!.jsonPrimitive.content, m.source)
            assertEquals(c["expectedMeasuredPower1m"]!!.jsonPrimitive.double, m.measuredPower1m, 0.0)
        }
        for (c in f["noCalibrationCases"]!!.jsonArray.map { it.jsonObject }) {
            val m = RssiModel.select(emptyList(), "x", "android", "Pixel", c["advertised"]?.jsonPrimitive?.intOrNull)
            assertEquals(c["expectedSource"]!!.jsonPrimitive.content, m.source)
        }
    }

    @Test
    fun windowFilterRejectsOutliersThrottlesAndDropsStale() {
        val f = BeaconMeasurementFilter()
        val model = RssiModel.DEFAULTS
        val results = (0 until 6).map { f.add("k", 1_000L + it * 250, -75.0 + it % 2, 1, model) }
        assertEquals(2, results.count { it.isSuccess }) // one per second
        val spike = f.add("k", 2_600, -50.0, 1, model)
        assertEquals(MeasurementRejection.RSSI_OUTLIER, (spike.exceptionOrNull() as BeaconMeasurementFilter.Rejected).reason)
        assertEquals(MeasurementRejection.RSSI_OUT_OF_RANGE, (f.add("k", 3_000, 0.0, 1, model).exceptionOrNull() as BeaconMeasurementFilter.Rejected).reason)
        assertEquals(MeasurementRejection.STALE, (f.add("k", -5_000, -70.0, 1, model).exceptionOrNull() as BeaconMeasurementFilter.Rejected).reason)
        assertEquals(MeasurementRejection.TOO_FAR, (f.add("far", 3_000, -99.0, 1, model).exceptionOrNull() as BeaconMeasurementFilter.Rejected).reason)
        val ok = f.add("k", 3_100, -74.0, 1, model).getOrThrow()
        assertTrue(ok.rangeM > 4 && ok.rangeM < 6)
        assertTrue(ok.upperRangeM > ok.rangeM)
        f.reset() // signal loss: windows forgotten
        val fresh = f.add("k", 9_000, -60.0, 10, model).getOrThrow()
        assertEquals(-60.0, fresh.medianRssi, 0.0)
        assertEquals(3, fresh.samples) // ~1 s iOS aggregate of 10 advertisements counts as at most 3 independent samples
    }
}

class BeaconObservationNormalizerTest {
    private val uuid = "e2c56db5-dffb-48d2-b060-d0f5a71096e0"
    private val packet = IBeaconParser.filterFor(uuid).first.also { it[18] = 0; it[19] = 7; it[20] = 0; it[21] = 9; it[22] = 0xC5.toByte() }
    private val normalizer = BeaconObservationNormalizer({ nanos -> 1_791_000_000_000L + nanos / 1_000_000 }, { "obs-1" })

    @Test
    fun keepsTheMonotonicTimestampAndMapsItToEpoch() {
        val o = normalizer.normalize(0x004C, packet, -71, 5_000_000_000L, setOf(uuid)).getOrThrow()
        assertEquals(1_791_000_005_000L, o.observedAtEpochMs)
        assertEquals(5_000_000_000L, o.elapsedRealtimeNanos)
        assertEquals(RssiAggregation.SINGLE_ADVERTISEMENT, o.rssiAggregation)
        assertEquals(-59, o.measuredPowerDbm)
        assertEquals(7 to 9, o.major to o.minor)
    }

    @Test
    fun rejectsUnusableRssiForeignUuidsAndNonBeacons() {
        fun reason(r: Result<BeaconObservation>) = (r.exceptionOrNull() as BeaconObservationNormalizer.Rejected).reason
        assertEquals(ObservationRejection.RSSI_UNUSABLE, reason(normalizer.normalize(0x004C, packet, 127, 0, null))) // "unavailable"
        assertEquals(ObservationRejection.NOT_REGISTERED, reason(normalizer.normalize(0x004C, packet, -70, 0, setOf("11111111-2222-4333-8444-555555555555"))))
        assertEquals(ObservationRejection.NOT_IBEACON, reason(normalizer.normalize(0x0006, packet, -70, 0, null)))
    }
}

class BeaconRegistryTest {
    private var now = 1_000_000L
    private val dir = Files.createTempDirectory("beacon").toFile()
    private val cache = BeaconRegistryCache(File(dir, "beacon-config.json"), { now }, AppJson)
    private val body = File("../../fixtures/beacon/beacon-config.json").takeIf { it.exists() }?.readText()
        ?: File("../fixtures/beacon/beacon-config.json").readText()

    @Test
    fun parsesTheSharedConfigAndResolvesIdentities() {
        val config = AppJson.decodeFromString(BeaconConfig.serializer(), body) // unknownFutureField ignored
        val registry = BeaconRegistry(config)
        val b = registry.lookup("E2C56DB5-DFFB-48D2-B060-D0F5A71096E0", 1, 2)!!
        assertEquals("3F", b.anchor!!.floor)
        assertEquals(201100.0, b.anchor.position.x, 0.0)
        assertNull(registry.lookup("e2c56db5-dffb-48d2-b060-d0f5a71096e0", 1, 99))
        assertEquals("BEACON_PLATFORM", registry.model(b, "ios", "iPhone15,2", null).source)
        assertEquals("ADVERTISED", registry.model(b, "android", "Pixel 8", null).source) // the iOS calibration is not used
        assertTrue("e2c56db5-dffb-48d2-b060-d0f5a71096e0" in registry.proximityUuids)
    }

    @Test
    fun cachePolicyEtagAndOfflineFallback() {
        val sync = BeaconConfigSync(cache, { now }, AppJson)
        var calls = 0
        var lastEtag: String? = "none"
        val ok = BeaconConfigFetcher { etag -> calls++; lastEtag = etag; Triple(200, "W/\"v7\"", body) }
        assertTrue(sync.refresh("srv", ok) is ConfigRefresh.Updated)
        assertNull(lastEtag)
        assertEquals(CacheFreshness.FRESH, cache.freshness(cache.load("srv")))
        assertTrue(sync.refresh("srv", ok) is ConfigRefresh.Skipped) // fresh: no request
        assertEquals(1, calls)
        now += 3_600_001
        assertEquals(CacheFreshness.STALE_USABLE, cache.freshness(cache.load("srv")))
        val notModified = sync.refresh("srv", { etag -> lastEtag = etag; Triple(304, etag, null) })
        assertTrue(notModified is ConfigRefresh.NotModified)
        assertEquals("W/\"v7\"", lastEtag)
        assertEquals(CacheFreshness.FRESH, cache.freshness(cache.load("srv")))
        // download failure (server down): the cache stays usable until staleMax
        now += 3_600_001
        val failed = sync.refresh("srv", { throw java.io.IOException("offline") })
        assertTrue(failed is ConfigRefresh.Failed && failed.cached != null)
        assertEquals(7L, cache.load("srv")!!.config.configVersion)
        now += 14L * 86_400_000
        assertEquals(CacheFreshness.EXPIRED, cache.freshness(cache.load("srv")))
        // another server never sees this cache; garbage on disk reads as missing
        assertNull(cache.load("other"))
        File(dir, "beacon-config.json").writeText("{broken")
        assertEquals(CacheFreshness.MISSING, cache.freshness(cache.load("srv")))
        assertTrue(sync.refresh("srv", { Triple(500, null, null) }) is ConfigRefresh.Failed)
    }
}

class BeaconPermissionsTest {
    @Test
    fun versionSpecificPermissions() {
        assertEquals(listOf(Manifest.permission.ACCESS_FINE_LOCATION), BeaconPermissions.required(30))
        assertEquals(listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.ACCESS_FINE_LOCATION), BeaconPermissions.required(31))
        assertEquals(listOf(Manifest.permission.BLUETOOTH_SCAN), BeaconPermissions.missing({ it == Manifest.permission.ACCESS_FINE_LOCATION }, 34))
        assertTrue(BeaconPermissions.missing({ true }, 26).isEmpty())
    }

    @Test
    fun manifestNeverOptsOutOfLocation() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val element = Regex("<uses-permission[^>]*android.permission.BLUETOOTH_SCAN[^>]*>").find(manifest)?.value
        assertNotNull(element)
        assertTrue("BLUETOOTH_SCAN must not carry usesPermissionFlags=neverForLocation: $element", !element!!.contains("usesPermissionFlags"))
    }
}

@Suppress("unused") private val keep = listOf(JsonArray(emptyList()), JsonNull.contentOrNull)
