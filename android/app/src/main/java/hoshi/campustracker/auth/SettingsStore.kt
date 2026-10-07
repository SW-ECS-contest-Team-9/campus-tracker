package hoshi.campustracker.auth

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.MotionSamplingRate
import hoshi.campustracker.net.ServerConfiguration
import hoshi.campustracker.net.ServerScheme
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import java.util.UUID

data class AppSettings(
    val server: ServerConfiguration? = null,
    val collectorId: String? = null,
    val deviceId: String = "",
    val webSocketUrl: String? = null,
    val motionRate: MotionSamplingRate = MotionSamplingRate.DEFAULT,
    val locationProfile: LocationCollectionProfile = LocationCollectionProfile.DEFAULT,
    val distanceFilter: Double = 0.0,
)

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "campus_collector")

/** Server settings, collector ID, device ID, sampling settings and the stored `webSocketURL` (§8.1, §12-12). */
class SettingsStore(private val context: Context) {
    private object Keys {
        val scheme = stringPreferencesKey("server.scheme")
        val host = stringPreferencesKey("server.host")
        val port = intPreferencesKey("server.port")
        val collectorId = stringPreferencesKey("collectorId")
        val deviceId = stringPreferencesKey("deviceId")
        val webSocketUrl = stringPreferencesKey("webSocketURL")
        val motionHz = intPreferencesKey("motionSamplingRate")
        val locationProfile = stringPreferencesKey("locationProfile")
        val distanceFilter = doublePreferencesKey("locationDistanceFilter")
    }

    val settings: Flow<AppSettings> = context.dataStore.data.map { p ->
        val host = p[Keys.host]
        AppSettings(
            server = host?.let {
                ServerConfiguration(ServerScheme.entries.firstOrNull { s -> s.name == p[Keys.scheme] } ?: ServerScheme.http, it, p[Keys.port] ?: 3000)
            },
            collectorId = p[Keys.collectorId],
            deviceId = p[Keys.deviceId].orEmpty(),
            webSocketUrl = p[Keys.webSocketUrl],
            motionRate = p[Keys.motionHz]?.let(MotionSamplingRate::fromHz) ?: MotionSamplingRate.DEFAULT,
            locationProfile = LocationCollectionProfile.fromName(p[Keys.locationProfile]),
            distanceFilter = p[Keys.distanceFilter] ?: 0.0,
        )
    }

    /** Device ID: created once on first run and reused forever (login body, X-Device-ID, session:start). */
    fun loadOrCreateDeviceIdBlocking(): String = runBlocking {
        val existing = context.dataStore.data.first()[Keys.deviceId]
        if (!existing.isNullOrEmpty()) return@runBlocking existing
        val created = UUID.randomUUID().toString()
        context.dataStore.edit { it[Keys.deviceId] = created }
        created
    }

    fun currentBlocking(): AppSettings = runBlocking { settings.first() }

    suspend fun saveServer(server: ServerConfiguration?, collectorId: String?) {
        context.dataStore.edit { p ->
            if (server == null) {
                p.remove(Keys.scheme); p.remove(Keys.host); p.remove(Keys.port)
            } else {
                p[Keys.scheme] = server.scheme.name; p[Keys.host] = server.host; p[Keys.port] = server.port
            }
            if (collectorId == null) p.remove(Keys.collectorId) else p[Keys.collectorId] = collectorId
        }
    }

    suspend fun saveWebSocketUrl(url: String?) {
        context.dataStore.edit { p -> if (url == null) p.remove(Keys.webSocketUrl) else p[Keys.webSocketUrl] = url }
    }

    suspend fun saveSampling(motionRate: MotionSamplingRate? = null, profile: LocationCollectionProfile? = null, distanceFilter: Double? = null) {
        context.dataStore.edit { p ->
            motionRate?.let { p[Keys.motionHz] = it.hz }
            profile?.let { p[Keys.locationProfile] = it.name }
            distanceFilter?.let { p[Keys.distanceFilter] = it.coerceIn(0.0, 100.0) }
        }
    }
}
