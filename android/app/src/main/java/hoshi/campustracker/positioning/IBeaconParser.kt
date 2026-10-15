package hoshi.campustracker.positioning

import java.util.Locale

/** One decoded iBeacon advertisement. Identity is (uuid, major, minor) — never the BLE MAC address, which rotates. */
data class IBeaconFrame(val uuid: String, val major: Int, val minor: Int, val measuredPowerDbm: Int) {
    val key: String get() = beaconKey(uuid, major, minor)
}

/** Same identity key as the server (`IBEACON:<lower-case uuid>:<major>:<minor>`). */
fun beaconKey(uuid: String, major: Int, minor: Int): String = "IBEACON:${uuid.lowercase(Locale.ROOT)}:$major:$minor"

/**
 * iBeacon Manufacturer Specific Data parser (pure, no Android types; shared with a future Navigator app).
 *
 * Layout after the 2-byte company ID 0x004C (Apple), which Android's `ScanRecord.getManufacturerSpecificData(0x004C)`
 * already strips:
 * ```
 * [0] 0x02 type   [1] 0x15 length (21)   [2..17] proximity UUID   [18..19] major (big endian)
 * [20..21] minor (big endian)            [22] measured power at 1 m (signed dBm)
 * ```
 * Anything else (another company, type or length, a short packet) returns null: such packets never become anchors.
 */
object IBeaconParser {
    const val APPLE_COMPANY_ID = 0x004C
    const val TYPE = 0x02
    const val LENGTH = 0x15
    /** bytes from the type byte through measured power */
    const val FRAME_SIZE = 23

    fun parse(manufacturerId: Int, data: ByteArray?): IBeaconFrame? {
        if (manufacturerId != APPLE_COMPANY_ID || data == null || data.size < FRAME_SIZE) return null
        if (data[0].toInt() and 0xFF != TYPE || data[1].toInt() and 0xFF != LENGTH) return null
        val uuid = buildString(36) {
            for (i in 2 until 18) {
                if (i == 6 || i == 8 || i == 10 || i == 12) append('-')
                append(String.format(Locale.ROOT, "%02x", data[i].toInt() and 0xFF))
            }
        }
        val major = ((data[18].toInt() and 0xFF) shl 8) or (data[19].toInt() and 0xFF)
        val minor = ((data[20].toInt() and 0xFF) shl 8) or (data[21].toInt() and 0xFF)
        val power = data[22].toInt() // signed byte, e.g. 0xC5 -> -59
        return IBeaconFrame(uuid, major, minor, power)
    }

    /** ScanFilter manufacturer data (without the company ID) that matches every iBeacon of [uuid], and its mask. */
    fun filterFor(uuid: String): Pair<ByteArray, ByteArray> {
        val hex = uuid.replace("-", "")
        require(hex.length == 32) { "UUID must have 32 hex digits" }
        val data = ByteArray(FRAME_SIZE)
        val mask = ByteArray(FRAME_SIZE)
        data[0] = TYPE.toByte(); mask[0] = 0xFF.toByte()
        data[1] = LENGTH.toByte(); mask[1] = 0xFF.toByte()
        for (i in 0 until 16) {
            data[2 + i] = hex.substring(2 * i, 2 * i + 2).toInt(16).toByte()
            mask[2 + i] = 0xFF.toByte()
        }
        return data to mask
    }

    fun hexToBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
}
