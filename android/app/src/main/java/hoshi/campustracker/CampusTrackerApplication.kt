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
import hoshi.campustracker.auth.KeystoreTokenStore
import hoshi.campustracker.auth.SettingsStore
import hoshi.campustracker.collection.AndroidCollectionPlatform
import hoshi.campustracker.collection.AppStateTracker
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
import hoshi.campustracker.sensors.AndroidAltimeterSource
import hoshi.campustracker.sensors.AndroidLocationSource
import hoshi.campustracker.sensors.AndroidMotionSource
import hoshi.campustracker.sensors.AndroidPedometerSource
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
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val auth = AuthenticationManager(settings, KeystoreTokenStore(app), CollectorApi(http), socket, sync, device, Dispatchers.IO.limitedParallelism(1))

    private val corrector = SensorTimestampCorrector(clock)
    private val location = AndroidLocationSource(app, collectionHandler, clock)
    private val motion = AndroidMotionSource(app, collectionHandler, clock, corrector)
    private val altimeter = AndroidAltimeterSource(app, collectionHandler, clock, corrector)
    private val pedometer = AndroidPedometerSource(app, collectionHandler, clock, corrector)
    private val root = File(app.filesDir, "CampusCollector")

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

    init {
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
