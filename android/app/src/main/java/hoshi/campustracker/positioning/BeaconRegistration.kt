package hoshi.campustracker.positioning

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.Locale
import kotlin.math.roundToLong

/**
 * Beacon registration form (pure). Same rules as the web page (frontend/src/beacon-scan.ts) and iOS, checked against
 * fixtures/beacon/registration-cases.json. Empty string = not entered; z may come from floorHeightM + mountAboveFloorM.
 */
data class BeaconRegistrationForm(
    val uuid: String = "",
    val major: String = "",
    val minor: String = "",
    val measuredPowerDbm: String = "",
    val label: String = "",
    val buildingId: String = "",
    val floor: String = "",
    val floorHeightM: String = "",
    val mountAboveFloorM: String = "",
    /** "wgs84" (latitude / longitude) or "grid" (EPSG:5186 x / y) */
    val positionMode: String = "wgs84",
    val latitude: String = "",
    val longitude: String = "",
    val x: String = "",
    val y: String = "",
    val z: String = "",
    val horizontalAccuracyM: String = "",
)

/** A registered beacon as the admin API lists it (`GET /admin/beacons`). Placement is EPSG:5186 only. */
@Serializable
data class AdminBeacon(
    val beaconId: String,
    val uuid: String,
    val major: Int,
    val minor: Int,
    val measuredPowerDbm: Int? = null,
    val enabled: Boolean = true,
    val label: String? = null,
    val lastObservedAt: String? = null,
    val anchor: AdminAnchor? = null,
) {
    val key: String get() = beaconKey(uuid, major, minor)
}

@Serializable
data class AdminAnchor(
    val anchorId: String,
    val buildingId: String,
    val floor: String? = null,
    val floorHeightM: Double? = null,
    val position: AnchorPosition,
    val horizontalAccuracyM: Double? = null,
)

sealed class RegistrationRequest {
    /** `POST /api/v1/positioning/admin/beacons` body */
    data class Body(val json: JsonObject) : RegistrationRequest()
    /** field name -> message (Korean, shown under the field) */
    data class Errors(val fields: Map<String, String>) : RegistrationRequest()
}

object BeaconRegistration {
    private val FLOOR = Regex("^(B[1-9]|[1-9][0-9]?F)$")

    /** "E2C56DB5DFFB48D2B060D0F5A71096E0", with dashes or braces -> lower-case 8-4-4-4-12, else null. */
    fun normalizeUuid(v: String): String? {
        val hex = v.trim().replace(Regex("[{}\\s-]"), "").lowercase(Locale.ROOT)
        if (!Regex("^[0-9a-f]{32}$").matches(hex)) return null
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }

    private fun num(v: String): Double? = v.trim().takeIf { it.isNotEmpty() }?.let { it.toDoubleOrNull() ?: Double.NaN }
    private fun isInt(d: Double) = d.isFinite() && d == Math.rint(d)

    /** 201100.0 -> "201100", 148.2 -> "148.2" */
    private fun plain(d: Double): String = d.toBigDecimal().stripTrailingZeros().toPlainString()

    /** The edit form of a registered beacon; the stored placement is EPSG:5186, so grid mode. */
    fun formFrom(b: AdminBeacon): BeaconRegistrationForm {
        val a = b.anchor
        return BeaconRegistrationForm(
            uuid = b.uuid.uppercase(Locale.ROOT), major = b.major.toString(), minor = b.minor.toString(),
            measuredPowerDbm = b.measuredPowerDbm?.toString() ?: "", label = b.label ?: "",
            buildingId = a?.buildingId ?: "", floor = a?.floor ?: "", floorHeightM = a?.floorHeightM?.let(::plain) ?: "",
            positionMode = if (a != null) "grid" else "wgs84",
            x = a?.position?.x?.let(::plain) ?: "", y = a?.position?.y?.let(::plain) ?: "", z = a?.position?.z?.let(::plain) ?: "",
            horizontalAccuracyM = a?.horizontalAccuracyM?.let(::plain) ?: "",
        )
    }

    /**
     * `PATCH /admin/beacons/:id` body from the edit form: same checks as a new beacon; identity is not sent (fixed);
     * empty power / label clear them; no placement unlinks the anchor.
     */
    fun buildEdit(f: BeaconRegistrationForm): RegistrationRequest = when (val r = build(f)) {
        is RegistrationRequest.Errors -> r
        is RegistrationRequest.Body -> RegistrationRequest.Body(buildJsonObject {
            put("measuredPowerDbm", r.json["measuredPowerDbm"] ?: JsonNull)
            put("label", r.json["label"] ?: JsonNull)
            val anchor = r.json["anchor"]
            if (anchor != null) put("anchor", anchor) else put("anchorId", JsonNull)
        })
    }

    fun build(f: BeaconRegistrationForm): RegistrationRequest {
        val errors = linkedMapOf<String, String>()
        val uuid = normalizeUuid(f.uuid) ?: null.also { errors["uuid"] = "UUID는 16진수 32자리입니다" }
        fun int16(key: String, v: String): Int? {
            val n = num(v)
            if (n == null || !isInt(n) || n < 0 || n > 65535) { errors[key] = "0~65535 정수"; return null }
            return n.toInt()
        }
        val major = int16("major", f.major)
        val minor = int16("minor", f.minor)
        val power = num(f.measuredPowerDbm)
        if (power != null && (!isInt(power) || power < -127 || power > 20)) errors["measuredPowerDbm"] = "−127~20 dBm 정수"
        val anchorWanted = listOf(f.buildingId, f.latitude, f.longitude, f.x, f.y).any { it.isNotBlank() }
        var anchor: JsonObject? = null
        if (anchorWanted) {
            if (f.buildingId.isBlank()) errors["buildingId"] = "건물(바깥이면 outdoor)을 고르세요"
            val floor = f.floor.trim().uppercase(Locale.ROOT)
            if (floor.isNotEmpty() && !FLOOR.matches(floor)) errors["floor"] = "1F…99F 또는 B1…B9"
            val floorHeight = num(f.floorHeightM)
            if (floorHeight != null && !floorHeight.isFinite()) errors["floorHeightM"] = "숫자"
            val mount = num(f.mountAboveFloorM)
            var z = num(f.z)
            if (z == null && floorHeight != null && mount != null && (floorHeight + mount).isFinite()) z = ((floorHeight + mount) * 1000).roundToLong() / 1000.0
            if (z == null || !z.isFinite()) errors["z"] = "설치 높이(해발 m) 또는 층 바닥 높이 + 바닥에서 높이를 넣으세요"
            var position: JsonObject? = null
            if (f.positionMode == "grid") {
                val x = num(f.x)
                val y = num(f.y)
                if (x == null || !(x in 100_000.0..700_000.0)) errors["x"] = "EPSG:5186 X(m)"
                if (y == null || !(y in 100_000.0..800_000.0)) errors["y"] = "EPSG:5186 Y(m)"
                if (x != null && y != null && z != null) position = buildJsonObject { put("x", x); put("y", y); put("z", z) }
            } else {
                val lat = num(f.latitude)
                val lon = num(f.longitude)
                if (lat == null || !(lat in 33.0..39.0)) errors["latitude"] = "위도 33~39"
                if (lon == null || !(lon in 124.0..132.0)) errors["longitude"] = "경도 124~132"
                if (lat != null && lon != null && z != null) position = buildJsonObject { put("latitude", lat); put("longitude", lon); put("z", z) }
            }
            val acc = num(f.horizontalAccuracyM)
            if (acc != null && !(acc > 0 && acc <= 100)) errors["horizontalAccuracyM"] = "0~100 m"
            anchor = buildJsonObject {
                put("buildingId", f.buildingId.trim())
                if (floor.isNotEmpty()) put("floor", floor)
                floorHeight?.let { put("floorHeightM", it) }
                position?.let { put("position", it) }
                acc?.let { put("horizontalAccuracyM", it) }
            }
        }
        if (errors.isNotEmpty()) return RegistrationRequest.Errors(errors)
        return RegistrationRequest.Body(buildJsonObject {
            put("uuid", uuid)
            put("major", major)
            put("minor", minor)
            power?.let { put("measuredPowerDbm", it.toInt()) }
            if (f.label.isNotBlank()) put("label", f.label.trim())
            anchor?.let { a -> putJsonObject("anchor") { a.forEach { (k, v) -> put(k, v) } } }
        })
    }
}

/** One beacon heard by the registration scan. */
data class HeardBeacon(
    val key: String, val uuid: String, val major: Int, val minor: Int, val measuredPower: Int,
    val count: Int, val lastRssi: Int?, val maxRssi: Int?, val lastSeenMs: Long, val registered: Boolean,
)

/** Beacons heard during one registration scan: unregistered first, strongest first. RSSI outside −120…−1 is ignored. */
class HeardBeacons(private val isRegistered: (String) -> Boolean = { false }) {
    private val byKey = LinkedHashMap<String, HeardBeacon>()

    fun add(frame: IBeaconFrame, rssi: Int?, atMs: Long) {
        val usable = rssi?.takeIf { it in -120..-1 }
        val prev = byKey[frame.key]
        byKey[frame.key] = if (prev == null) {
            HeardBeacon(frame.key, frame.uuid, frame.major, frame.minor, frame.measuredPowerDbm, 1, usable, usable, atMs, false)
        } else {
            prev.copy(count = prev.count + 1, lastRssi = usable ?: prev.lastRssi,
                maxRssi = if (usable == null) prev.maxRssi else maxOf(prev.maxRssi ?: -999, usable), lastSeenMs = atMs, measuredPower = frame.measuredPowerDbm)
        }
    }

    fun list(): List<HeardBeacon> = byKey.values.map { it.copy(registered = isRegistered(it.key)) }
        .sortedWith(compareBy<HeardBeacon> { it.registered }.thenByDescending { it.maxRssi ?: -999 }.thenBy { it.key })

    fun clear() = byKey.clear()
}
