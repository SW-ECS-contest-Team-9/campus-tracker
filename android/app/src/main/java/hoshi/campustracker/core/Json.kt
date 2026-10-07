package hoshi.campustracker.core

import kotlinx.serialization.json.Json

/** Wire and local-file JSON: nulls omitted, unknown keys ignored, defaults written (e.g. `platform`). */
val AppJson: Json = Json {
    explicitNulls = false
    ignoreUnknownKeys = true
    encodeDefaults = true
    coerceInputValues = true
}

/** JSON cannot carry NaN or infinity; network/local DTOs carry null instead (§3.1). */
fun Double.finiteOrNull(): Double? = if (isFinite()) this else null
fun Float.finiteOrNull(): Double? = if (isFinite()) toDouble() else null
