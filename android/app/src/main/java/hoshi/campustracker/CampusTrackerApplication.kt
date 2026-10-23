package hoshi.campustracker

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import androidx.core.content.ContextCompat
import hoshi.campustracker.auth.AuthenticationManager
import hoshi.campustracker.positioning.AdminBeacon
import hoshi.campustracker.auth.KeystoreTokenStore
import hoshi.campustracker.auth.SettingsStore
import hoshi.campustracker.collection.AndroidCollectionPlatform
import hoshi.campustracker.collection.AppStateTracker
import hoshi.campustracker.collection.BeaconCollectionController
import hoshi.campustracker.collection.BeaconRegistrationController
import hoshi.campustracker.collection.GeoFix
import hoshi.campustracker.collection.RegistrationBackend
import hoshi.campustracker.net.AnchorBuilding
import hoshi.campustracker.net.ApiError
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import android.location.LocationManager
import androidx.core.location.LocationManagerCompat
import androidx.core.os.CancellationSignal
import kotlin.coroutines.resume
import hoshi.campustracker.collection.CollectionCoordinator
import hoshi.campustracker.collection.HandlerExecutor
import hoshi.campustracker.collection.PermissionHistory
import hoshi.campustracker.core.SensorTimestampCorrector
import hoshi.campustracker.core.SystemCollectorClock
import hoshi.campustracker.model.DeviceInfo
import hoshi.campustracker.net.CollectorApi
import hoshi.campustracker.net.RawWebSocketManager
import hoshi.campustracker.persistence.FileActiveCollectionStore
import hoshi.campustracker.persistence.LocalSensorDataRepository
import hoshi.campustracker.persistence.SavedRoutesStore
import hoshi.campustracker.sensors.AndroidAltimeterSource
import hoshi.campustracker.sensors.AndroidLocationSource
import hoshi.campustracker.sensors.AndroidMotionSource
import hoshi.campustracker.sensors.AndroidPedometerSource
import hoshi.campustracker.auth.AuthState
import hoshi.campustracker.core.AppJson
import hoshi.campustracker.positioning.AndroidBleBeaconScanner
import hoshi.campustracker.positioning.BeaconRegistryCache
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import hoshi.campustracker.sync.RoomUploadQueueStore
import hoshi.campustracker.sync.TelemetrySyncCoordinator
import hoshi.campustracker.sync.UploadQueueDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.Executors

class CampusTrackerApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

/**
 * Application-scoped singletons: collection, upload and the WebSocket survive Activity recreation (§2).
 * Threads: one HandlerThread for sensors + collection, one thread for the upload queue, one for the socket.
 */
class AppGraph(app: Application) {
    val clock = SystemCollectorClock()
    private val collectionThread = HandlerThread("CampusCollector.collection").apply { start() }
    private val collectionHandler = Handler(collectionThread.looper)
    private val syncScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor { Thread(it, "CampusCollector.sync") }.asCoroutineDispatcher())
    private val socketScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor { Thread(it, "CampusCollector.socket") }.asCoroutineDispatcher())
    private val http = OkHttpClient()

    val settings = SettingsStore(app)
    val permissionHistory = PermissionHistory(app)
    val device = DeviceInfo(
        deviceId = settings.loadOrCreateDeviceIdBlocking(),
        deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}".take(64),
        systemVersion = Build.VERSION.RELEASE.take(32),
        appVersion = BuildConfig.VERSION_NAME.take(32),
    )

    val socket = RawWebSocketManager(http, socketScope)
    private val queue = RoomUploadQueueStore(UploadQueueDatabase.open(app).dao())
    val sync = TelemetrySyncCoordinator(queue, socket, syncScope, clock::nowMs)
    val api = CollectorApi(http)
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val auth = AuthenticationManager(settings, KeystoreTokenStore(app), api, socket, sync, device, Dispatchers.IO.limitedParallelism(1))

    private val corrector = SensorTimestampCorrector(clock)
    private val location = AndroidLocationSource(app, collectionHandler, clock)
    private val motion = AndroidMotionSource(app, collectionHandler, clock, corrector)
    private val altimeter = AndroidAltimeterSource(app, collectionHandler, clock, corrector)
    private val pedometer = AndroidPedometerSource(app, collectionHandler, clock, corrector)
    private val root = File(app.filesDir, "CampusCollector")
    val savedRoutes = SavedRoutesStore(root)

    private val appState: AppStateTracker = AppStateTracker { state -> coordinator.handleAppState(state) }

    val coordinator: CollectionCoordinator = CollectionCoordinator(
        clock = clock,
        executor = HandlerExecutor(collectionHandler),
        location = location, motion = motion, altimeter = altimeter, pedometer = pedometer,
        repository = LocalSensorDataRepository(root, clock::nowMs),
        activeStore = FileActiveCollectionStore(root),
        sync = sync,
        platform = AndroidCollectionPlatform(app, motion, altimeter, pedometer, permissionHistory),
        device = device,
        appState = { appState.current },
    )

    /** BLE beacons (docs/BEACON_POSITIONING.md): own thread, never on the collection or upload path. */
    private val beaconScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor { Thread(it, "CampusCollector.beacon") }.asCoroutineDispatcher())
    val beacons = BeaconCollectionController(
        scanner = AndroidBleBeaconScanner(app, clock, collectionHandler),
        cache = BeaconRegistryCache(File(root, "beacon-config.json"), clock::nowMs, AppJson),
        sync = sync,
        scope = beaconScope,
        nowMs = clock::nowMs,
    )

    /** Beacon registration screen (admin tooling): own scanner and thread, independent of collection. */
    private val registrationScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor { Thread(it, "CampusCollector.beaconRegistration") }.asCoroutineDispatcher())
    private val registrationBackend = object : RegistrationBackend {
        private fun server() = auth.configuration.value ?: throw ApiError.CannotConnect()
        private fun token() = auth.accessToken() ?: throw ApiError.Http(401, "TOKEN_REQUIRED", null)
        override fun canRegister(): Boolean { api.positioningAdminGet(server(), token(), "/me"); return true }
        override fun beacons(): List<AdminBeacon> {
            val body = AppJson.parseToJsonElement(api.positioningAdminGet(server(), token(), "/beacons", mapOf("includeDisabled" to "true"))).jsonObject
            return AppJson.decodeFromJsonElement(ListSerializer(AdminBeacon.serializer()), body["beacons"]!!)
        }
        override fun register(body: JsonObject): String {
            val b = AppJson.parseToJsonElement(api.positioningAdminPost(server(), token(), "/beacons", body.toString())).jsonObject
            val label = (b["label"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
            return listOfNotNull(label, "${b["uuid"]!!.jsonPrimitive.content} / ${b["major"]} / ${b["minor"]}").joinToString(" · ")
        }
        override fun update(beaconId: String, body: JsonObject): AdminBeacon =
            AppJson.decodeFromString(AdminBeacon.serializer(), api.positioningAdminSend(server(), token(), "PATCH", "/beacons/$beaconId", body.toString()))
        override fun delete(beaconId: String) {
            api.positioningAdminSend(server(), token(), "DELETE", "/beacons/$beaconId", query = mapOf("permanent" to "true"))
        }
        override fun buildings(): List<AnchorBuilding> = api.anchorNodes(server(), null, null, null, null).buildings
    }
    @android.annotation.SuppressLint("MissingPermission") // the screen asks for location first; a SecurityException reads as "no fix"
    private suspend fun currentLocation(app: Application): GeoFix? {
        // a fix of the running collection (less than 30 s old) is as good as a new one
        coordinator.ui.value.latestLocation?.takeIf { latest -> coordinator.ui.value.lastLocationMs?.let { clock.nowMs() - it < 30_000 } == true }
            ?.let { return GeoFix(it.latitude, it.longitude, it.horizontalAccuracy) }
        val lm = app.getSystemService(LocationManager::class.java) ?: return null
        val provider = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) } ?: return null
        return withTimeoutOrNull(15_000) {
            suspendCancellableCoroutine { cont ->
                val cancel = CancellationSignal()
                cont.invokeOnCancellation { cancel.cancel() }
                try {
                    LocationManagerCompat.getCurrentLocation(lm, provider, cancel, ContextCompat.getMainExecutor(app)) { loc ->
                        cont.resume(loc?.let { GeoFix(it.latitude, it.longitude, if (it.hasAccuracy()) it.accuracy.toDouble() else null) })
                    }
                } catch (e: SecurityException) { cont.resume(null) }
            }
        }
    }
    val beaconRegistration = BeaconRegistrationController(
        scanner = AndroidBleBeaconScanner(app, clock, collectionHandler),
        backend = registrationBackend,
        currentLocation = { currentLocation(app) },
        scope = registrationScope,
        nowMs = clock::nowMs,
        onRegistered = { beacons.refreshConfig() },
    )

    init {
        sync.deviceModel = device.deviceModel
        beaconScope.launch {
            data class Inputs(val session: String?, val scanning: Boolean, val upload: Boolean, val serverKey: String?, val signedIn: Boolean)
            combine(coordinator.ui, settings.settings, auth.state, auth.configuration) { ui, s, a, server ->
                Inputs(ui.activeSession?.id, s.beaconScanningEnabled, s.beaconUploadEnabled, server?.serverKey, a is AuthState.Authenticated)
            }.distinctUntilChanged().collect { i ->
                val server = auth.configuration.value
                val fetch: ((String?) -> Triple<Int, String?, String?>)? = if (i.signedIn && server != null) {
                    { etag -> api.beaconConfig(server, auth.accessToken() ?: error("signed out"), etag) }
                } else null
                beacons.update(i.session, i.scanning, i.upload, i.serverKey, fetch)
            }
        }
        sync.onServerSessionStarted = { local, server -> coordinator.onServerSessionStarted(local, server) }
        appState.install()
        ContextCompat.registerReceiver(
            app,
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    coordinator.onPowerSaveModeChanged(context.getSystemService(PowerManager::class.java).isPowerSaveMode)
                }
            },
            IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        auth.restore()
    }
}
