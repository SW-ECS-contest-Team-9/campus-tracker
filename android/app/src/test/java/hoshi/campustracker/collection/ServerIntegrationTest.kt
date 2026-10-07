package hoshi.campustracker.collection

import hoshi.campustracker.core.L
import hoshi.campustracker.model.CollectorAppState
import hoshi.campustracker.model.DeviceInfo
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.MotionSamplingRate
import hoshi.campustracker.net.CollectorApi
import hoshi.campustracker.net.ConnectionState
import hoshi.campustracker.net.LoginRequest
import hoshi.campustracker.net.RawWebSocketManager
import hoshi.campustracker.net.ServerConfiguration
import hoshi.campustracker.net.ServerScheme
import hoshi.campustracker.net.SocketParams
import hoshi.campustracker.persistence.FileActiveCollectionStore
import hoshi.campustracker.persistence.LocalSensorDataRepository
import hoshi.campustracker.sensors.MotionReading
import hoshi.campustracker.sync.InMemoryUploadQueueStore
import hoshi.campustracker.sync.TelemetrySyncCoordinator
import hoshi.campustracker.sync.UploadOwner
import hoshi.campustracker.sync.Vec3
import hoshi.campustracker.sync.AttitudePayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Opt-in end-to-end run against a real local backend (`CT_SERVER_HOST=127.0.0.1 CT_COLLECTOR=C02`): login, raw
 * WebSocket, session:start, batches, marker, a forced reconnect, session:finish. Skipped unless the env var is set.
 * Only for a local development server — never point it at a production server (§15.2).
 */
class ServerIntegrationTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun fullSessionAgainstLocalServer() {
        val host = System.getenv("CT_SERVER_HOST")
        assumeTrue("set CT_SERVER_HOST to run", host != null)
        L.sink = { level, tag, message, error -> println("$level/$tag: $message${error?.let { " ($it)" } ?: ""}") }
        val collector = System.getenv("CT_COLLECTOR") ?: "C02"
        val config = ServerConfiguration(ServerScheme.http, host!!, (System.getenv("CT_SERVER_PORT") ?: "3000").toInt())
        val device = DeviceInfo(UUID.randomUUID().toString(), "jvm IntegrationTest", "test", "1.0")
        val http = OkHttpClient()
        val login = CollectorApi(http).login(config, LoginRequest(collector, device.deviceId, deviceModel = device.deviceModel, systemVersion = device.systemVersion, appVersion = device.appVersion))
        println("login collector=${login.collectorId} ws=${login.webSocketURL}")

        val socketScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor().asCoroutineDispatcher())
        val syncScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor().asCoroutineDispatcher())
        val socket = RawWebSocketManager(http, socketScope)
        val queue = InMemoryUploadQueueStore()
        val clock = FakeClock(System.currentTimeMillis())
        val sync = TelemetrySyncCoordinator(queue, socket, syncScope, { System.currentTimeMillis() })
        val owner = UploadOwner(login.collectorId, config.serverKey)
        sync.setOwner(owner)
        val params = SocketParams(login.webSocketURL ?: config.defaultWebSocketUrl, login.accessToken, device.deviceId)
        socket.connect(params)

        val executor = ManualExecutor(clock)
        val location = FakeLocation()
        val motion = FakeMotion()
        val altimeter = FakeAltimeter()
        val pedometer = FakePedometer()
        val coordinator = CollectionCoordinator(
            clock, executor, location, motion, altimeter, pedometer,
            LocalSensorDataRepository(tmp.root, { clock.now }), FileActiveCollectionStore(tmp.root), sync,
            FakePlatform(motion, altimeter, pedometer), device, { CollectorAppState.FOREGROUND },
        )
        sync.onServerSessionStarted = { local, server -> println("server session $server for $local") }
        coordinator.startSession(login.collectorId, owner, MotionSamplingRate.hz50, LocationCollectionProfile.highAccuracy, 0.0)
        executor.runAll()

        // 6 s of synthetic 50 Hz motion (flat phone slowly turning) + 1 Hz fixes, in real time.
        val start = System.currentTimeMillis()
        var i = 0
        while (System.currentTimeMillis() - start < 6_000) {
            clock.now = System.currentTimeMillis()
            val yaw = -PI / 2 + i * 0.002
            motion.callback?.invoke(
                MotionReading(clock.now * 1_000_000, Vec3(0.0, 0.0, 0.01 * sin(i / 5.0)), Vec3(0.0, 0.0, 0.1), Vec3(0.0, 0.0, -1.0), AttitudePayload(0.0, 0.0, yaw)),
            )
            if (i % 50 == 0) location.emit(clock.now, 37.6105 + i * 1e-7, 127.0102 + cos(i / 100.0) * 1e-6)
            if (i == 150) coordinator.addMarker(EventMarkerType.stairStart)
            if (i == 200) socket.connect(params) // forced reconnect mid-session → same clientSessionId, session.resumed
            executor.advance(20)
            Thread.sleep(20)
            i++
        }
        coordinator.stopSession()
        executor.runAll()

        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline && (sync.status.value.pending > 0 || queue.sessions().isNotEmpty())) Thread.sleep(200)
        println("final status=${sync.status.value} socket=${socket.state.value} sessionsLeft=${queue.sessions().size}")
        assertEquals(ConnectionState.Connected, socket.state.value)
        assertEquals(0, sync.status.value.pending)
        assertEquals(0, sync.status.value.quarantined)
        socket.disconnect()
        Thread.sleep(300)
    }
}
