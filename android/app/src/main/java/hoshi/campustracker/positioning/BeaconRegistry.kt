package hoshi.campustracker.positioning

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.Locale

// `GET /api/v1/positioning/beacon-config` (docs/BEACON_POSITIONING.md). Unknown fields are ignored.

@Serializable
data class AnchorPosition(val x: Double, val y: Double, val z: Double)

@Serializable
data class BeaconAnchor(
    val anchorId: String,
    val anchorType: String = "BEACON",
    val buildingId: String,
    val floor: String? = null,
    val floorHeightM: Double? = null,
    /** EPSG:5186 metres; z = mounting height above MSL (KVD Incheon) */
    val position: AnchorPosition,
    val latitude: Double,
    val longitude: Double,
    val horizontalAccuracyM: Double = 1.0,
    val verticalAccuracyM: Double = 1.0,
)

@Serializable
data class BeaconCalibration(
    /** null in defaultCalibrations (every beacon); the beacon's id when nested under it */
    val beaconId: String? = null,
    val platform: String = "*",
    val deviceGroup: String = "*",
    val measuredPower1m: Double,
    val pathLossExponent: Double,
    val rssiVariance: Double,
    val sampleCount: Int = 0,
)

@Serializable
data class RegisteredBeacon(
    val beaconId: String,
    val protocol: String = "IBEACON",
    val uuid: String,
    val major: Int,
    val minor: Int,
    val measuredPowerDbm: Int? = null,
    val anchor: BeaconAnchor? = null,
    val calibrations: List<BeaconCalibration> = emptyList(),
) {
    val key: String get() = beaconKey(uuid, major, minor)
}

@Serializable
data class BeaconFeatures(val scanning: Boolean = false, val upload: Boolean = false, val fusion: Boolean = false, val floorCorrection: Boolean = false)

@Serializable
data class CachePolicy(val maxAgeSeconds: Long = 3_600, val staleMaxSeconds: Long = 14 * 86_400)

@Serializable
data class RssiDefaults(val measuredPower1m: Double = -59.0, val pathLossExponent: Double = 2.2, val rssiVariance: Double = 36.0)

@Serializable
data class BeaconConfig(
    val schemaVersion: Int,
    val configVersion: Long,
    val updatedAt: String? = null,
    val cachePolicy: CachePolicy = CachePolicy(),
    val features: BeaconFeatures = BeaconFeatures(),
    val proximityUuids: List<String> = emptyList(),
    val rssiDefaults: RssiDefaults = RssiDefaults(),
    val defaultCalibrations: List<BeaconCalibration> = emptyList(),
    val beacons: List<RegisteredBeacon> = emptyList(),
)

/** Read-only lookup over one config: identity -> beacon (with anchor) and its RSSI model for this phone. */
class BeaconRegistry(val config: BeaconConfig) {
    private val byKey = config.beacons.associateBy { it.key }
    val proximityUuids: Set<String> = config.proximityUuids.map { it.lowercase(Locale.ROOT) }.toSet()

    fun lookup(uuid: String, major: Int, minor: Int): RegisteredBeacon? = byKey[beaconKey(uuid, major, minor)]

    fun model(beacon: RegisteredBeacon, platform: String, deviceModel: String?, advertisedPower: Int?): RssiModel {
        val rows = beacon.calibrations.map { it.copy(beaconId = beacon.beaconId) } + config.defaultCalibrations.map { it.copy(beaconId = null) }
        return RssiModel.select(rows, beacon.beaconId, platform, deviceModel, advertisedPower ?: beacon.measuredPowerDbm, config.rssiDefaults)
    }
}

/** What is cached on disk: the config, its ETag and when it was last confirmed by the server. */
@Serializable
data class CachedBeaconConfig(val config: BeaconConfig, val etag: String?, val fetchedAtMs: Long, val serverKey: String)

enum class CacheFreshness { FRESH, STALE_USABLE, EXPIRED, MISSING }

/**
 * File cache of the beacon config (atomic replace). Positioning keeps working offline with a cached config until
 * `staleMaxSeconds`; after `maxAgeSeconds` it is re-validated (If-None-Match) when the server is reachable.
 * A config of another server is never used.
 */
class BeaconRegistryCache(private val file: File, private val nowMs: () -> Long, private val json: Json) {
    fun load(serverKey: String): CachedBeaconConfig? {
        if (!file.exists()) return null
        val cached = runCatching { json.decodeFromString(CachedBeaconConfig.serializer(), file.readText()) }.getOrNull() ?: return null
        return cached.takeIf { it.serverKey == serverKey && it.config.schemaVersion == 1 }
    }

    fun freshness(cached: CachedBeaconConfig?): CacheFreshness {
        if (cached == null) return CacheFreshness.MISSING
        val age = nowMs() - cached.fetchedAtMs
        return when {
            age < 0 -> CacheFreshness.STALE_USABLE // clock moved back: re-validate, but keep using it
            age < cached.config.cachePolicy.maxAgeSeconds * 1000 -> CacheFreshness.FRESH
            age < cached.config.cachePolicy.staleMaxSeconds * 1000 -> CacheFreshness.STALE_USABLE
            else -> CacheFreshness.EXPIRED
        }
    }

    fun save(cached: CachedBeaconConfig) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(json.encodeToString(CachedBeaconConfig.serializer(), cached))
        if (!tmp.renameTo(file)) {
            file.delete()
            check(tmp.renameTo(file)) { "could not replace ${file.name}" }
        }
    }

    fun clear() {
        file.delete()
    }
}

/** Outcome of one config refresh; the cache is kept on every failure (the server being down never stops collection). */
sealed class ConfigRefresh {
    data class Updated(val cached: CachedBeaconConfig) : ConfigRefresh()
    data class NotModified(val cached: CachedBeaconConfig) : ConfigRefresh()
    data class Skipped(val cached: CachedBeaconConfig) : ConfigRefresh()
    data class Failed(val cached: CachedBeaconConfig?, val message: String) : ConfigRefresh()
}

/** HTTP side of the refresh, injected (OkHttp in the app, a fake in tests). */
fun interface BeaconConfigFetcher {
    /** Returns (status, etag, body); status 304 = not modified (body null). Throws on network errors. */
    fun fetch(etag: String?): Triple<Int, String?, String?>
}

class BeaconConfigSync(private val cache: BeaconRegistryCache, private val nowMs: () -> Long, private val json: Json) {
    fun refresh(serverKey: String, fetcher: BeaconConfigFetcher, force: Boolean = false): ConfigRefresh {
        val cached = cache.load(serverKey)
        if (!force && cached != null && cache.freshness(cached) == CacheFreshness.FRESH) return ConfigRefresh.Skipped(cached)
        return try {
            val (status, etag, body) = fetcher.fetch(cached?.etag)
            when {
                status == 304 && cached != null -> cached.copy(fetchedAtMs = nowMs()).also(cache::save).let { ConfigRefresh.NotModified(it) }
                status == 200 && body != null -> {
                    val config = json.decodeFromString(BeaconConfig.serializer(), body)
                    if (config.schemaVersion != 1) return ConfigRefresh.Failed(cached, "unsupported schemaVersion ${config.schemaVersion}")
                    CachedBeaconConfig(config, etag, nowMs(), serverKey).also(cache::save).let { ConfigRefresh.Updated(it) }
                }
                else -> ConfigRefresh.Failed(cached, "HTTP $status")
            }
        } catch (e: Exception) {
            ConfigRefresh.Failed(cached, e.message ?: e.javaClass.simpleName)
        }
    }
}
