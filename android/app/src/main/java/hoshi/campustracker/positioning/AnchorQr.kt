package hoshi.campustracker.positioning

import java.util.UUID

/** A QR is only a node ID; the server supplies its current coordinates. */
fun parseAnchorQr(value: String): String? {
    val prefix = "campustracker:node:"
    if (!value.startsWith(prefix)) return null
    val raw = value.removePrefix(prefix)
    return runCatching { UUID.fromString(raw).toString().takeIf { it.equals(raw, ignoreCase = true) } }.getOrNull()
}
