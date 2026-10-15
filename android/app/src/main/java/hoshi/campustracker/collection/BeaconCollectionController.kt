package hoshi.campustracker.collection

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.core.Iso
import hoshi.campustracker.core.L
import hoshi.campustracker.positioning.BeaconConfigSync
import hoshi.campustracker.positioning.BeaconObservation
import hoshi.campustracker.positioning.BeaconRegistry
import hoshi.campustracker.positioning.BeaconRegistryCache
import hoshi.campustracker.positioning.BeaconScanner
import hoshi.campustracker.positioning.BeaconScannerState
import hoshi.campustracker.positioning.CacheFreshness
import hoshi.campustracker.positioning.CachedBeaconConfig
import hoshi.campustracker.positioning.ConfigRefresh
import hoshi.campustracker.sync.BeaconObservationPayload
import hoshi.campustracker.sync.TelemetrySyncCoordinator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** What the collector should do with beacons right now (pure; unit-tested). */
data class BeaconCollectionPlan(val scan: Boolean, val upload: Boolean, val uuids: Set<String>, val reason: String)

object BeaconCollectionPolicy {
    /**
     * Scans only during an active session, with the local switch on, the server's remote switch on and a usable
     * registry (fresh or stale-but-usable cache). An expired cache still lets the collector record raw observations of
     * the UUIDs it knows (the server resolves them); the remote switch of an expired config is not trusted to be on.
     */
    fun decide(activeSession: Boolean, localScanning: Boolean, localUpload: Boolean, cached: CachedBeaconConfig?, freshness: CacheFreshness): BeaconCollectionPlan {
        if (!activeSession) return BeaconCollectionPlan(false, false, emptySet(), "NO_ACTIVE_SESSION")
        if (!localScanning) return BeaconCollectionPlan(false, false, emptySet(), "LOCAL_SWITCH_OFF")
        if (cached == null) return BeaconCollectionPlan(false, false, emptySet(), "NO_CONFIG")
        val features = cached.config.features
        if (freshness != CacheFreshness.EXPIRED && !features.scanning) return BeaconCollectionPlan(false, false, emptySet(), "SERVER_SWITCH_OFF")
        val uuids = BeaconRegistry(cached.config).proximityUuids
        if (uuids.isEmpty()) return BeaconCollectionPlan(false, false, emptySet(), "NO_REGISTERED_BEACONS")
        val upload = localUpload && (freshness == CacheFreshness.EXPIRED || features.upload)
        return BeaconCollectionPlan(true, upload, uuids, if (freshness == CacheFreshness.EXPIRED) "EXPIRED_CONFIG" else "OK")
    }
}

data class BeaconUiState(
    val plan: BeaconCollectionPlan? = null,
    val scanner: BeaconScannerState = BeaconScannerState.Idle,
    val configVersion: Long? = null,
    val configFreshness: CacheFreshness = CacheFreshness.MISSING,
    val lastRefreshError: String? = null,
    val observations: Long = 0,
    val registeredObservations: Long = 0,
    val lastObservationMs: Long? = null,
)

/**
 * Collector-only glue: active session + switches + cached registry -> [BeaconScanner] -> upload queue. Never part of
 * [CollectionCoordinator]: beacons failing (no Bluetooth, no permission, no server) cannot affect GPS / IMU /
 * barometer collection. All state is confined to [scope] (single-threaded).
 */
class BeaconCollectionController(
    private val scanner: BeaconScanner,
    private val cache: BeaconRegistryCache,
    private val sync: TelemetrySyncCoordinator,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long,
) {
    companion object { private const val TAG = "BeaconCollection" }

    private val configSync = BeaconConfigSync(cache, nowMs, AppJson)
    private val _ui = MutableStateFlow(BeaconUiState())
    val ui: StateFlow<BeaconUiState> = _ui

    private var registry: BeaconRegistry? = null
    private var lastUpdate: ((Boolean) -> Unit)? = null

    /** The registry changed (a beacon was registered from this phone): re-download the config now, not after maxAge. */
    fun refreshConfig() = scope.launch { lastUpdate?.invoke(true) }
    private var scanningUuids: Set<String>? = null
    private var activeSessionId: String? = null

    init {
        scanner.onStateChanged = { s -> scope.launch { _ui.value = _ui.value.copy(scanner = s) } }
    }

    /**
     * Re-evaluates the plan. [fetch] downloads the config (null = signed out / offline; the cache is used as is).
     * Called on session start/stop, switch changes and login.
     */
    fun update(activeSessionId: String?, localScanning: Boolean, localUpload: Boolean, serverKey: String?,
        fetch: ((String?) -> Triple<Int, String?, String?>)?, force: Boolean = false): Job = scope.launch {
        lastUpdate = { f -> update(activeSessionId, localScanning, localUpload, serverKey, fetch, f) }
        this@BeaconCollectionController.activeSessionId = activeSessionId
        var cached = serverKey?.let(cache::load)
        if (serverKey != null && fetch != null && activeSessionId != null && localScanning) {
            when (val r = configSync.refresh(serverKey, { etag -> fetch(etag) }, force)) {
                is ConfigRefresh.Updated -> { cached = r.cached; _ui.value = _ui.value.copy(lastRefreshError = null) }
                is ConfigRefresh.NotModified -> { cached = r.cached; _ui.value = _ui.value.copy(lastRefreshError = null) }
                is ConfigRefresh.Skipped -> cached = r.cached
                is ConfigRefresh.Failed -> { cached = r.cached; _ui.value = _ui.value.copy(lastRefreshError = r.message) }
            }
        }
        val freshness = cache.freshness(cached)
        val plan = BeaconCollectionPolicy.decide(activeSessionId != null, localScanning, localUpload, cached, freshness)
        registry = cached?.let { BeaconRegistry(it.config) }
        // while scanning: the plan (local + remote switch); otherwise held batches of earlier sessions follow the local switch
        sync.beaconUploadEnabled = if (plan.scan) plan.upload else localUpload
        _ui.value = _ui.value.copy(plan = plan, configVersion = cached?.config?.configVersion, configFreshness = freshness)
        if (!plan.scan) {
            if (scanningUuids != null) scanner.stop()
            scanningUuids = null
            return@launch
        }
        if (scanningUuids != plan.uuids) {
            scanningUuids = plan.uuids
            L.i(TAG, "beacon scan plan=${plan.reason} uuids=${plan.uuids.size} upload=${plan.upload} config=${cached?.config?.configVersion}")
            scanner.start(plan.uuids) { o -> scope.launch { record(o) } }
        }
    }

    private fun record(o: BeaconObservation) {
        if (activeSessionId == null || scanningUuids == null) return
        val registered = registry?.lookup(o.uuid, o.major, o.minor) != null
        val s = _ui.value
        _ui.value = s.copy(observations = s.observations + 1, registeredObservations = s.registeredObservations + if (registered) 1 else 0,
            lastObservationMs = o.observedAtEpochMs)
        // always queued (durable raw data); upload is gated in the sync coordinator by sync.beaconUploadEnabled
        sync.appendBeacon(toPayload(o))
    }
}

/** BeaconObservation -> wire row (the raw value is uploaded unfiltered; filtering is fusion's job). */
fun toPayload(o: BeaconObservation) = BeaconObservationPayload(
    observationId = o.observationId, protocol = o.protocol, uuid = o.uuid, major = o.major, minor = o.minor, rssiDbm = o.rssiDbm,
    observedAt = Iso.format(o.observedAtEpochMs), measuredPowerDbm = o.measuredPowerDbm, proximity = o.proximity,
    platformEstimatedDistanceMeters = o.platformEstimatedDistanceMeters, observationTimeUncertaintyMs = o.observationTimeUncertaintyMs,
    rssiAggregation = o.rssiAggregation, sampleCount = o.sampleCount,
)
