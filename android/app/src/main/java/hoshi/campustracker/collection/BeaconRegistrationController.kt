package hoshi.campustracker.collection

import hoshi.campustracker.net.AnchorBuilding
import hoshi.campustracker.positioning.AdminBeacon
import hoshi.campustracker.net.ApiError
import hoshi.campustracker.positioning.BeaconObservationListener
import hoshi.campustracker.positioning.BeaconRegistration
import hoshi.campustracker.positioning.BeaconRegistrationForm
import hoshi.campustracker.positioning.BeaconScannerState
import hoshi.campustracker.positioning.HeardBeacon
import hoshi.campustracker.positioning.HeardBeacons
import hoshi.campustracker.positioning.IBeaconFrame
import hoshi.campustracker.positioning.RegistrationRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale

/** Registration survey scan: every iBeacon in range (AndroidBleBeaconScanner.startSurvey). */
interface SurveyScanner {
    val state: BeaconScannerState
    var onStateChanged: ((BeaconScannerState) -> Unit)?
    fun startSurvey(listener: BeaconObservationListener)
    fun stop()
}

/** Server side of registration (the admin API with this collector's token). Blocking calls, run on [scope]. */
interface RegistrationBackend {
    /** true = this account may register (POSITIONING_ADMIN_COLLECTORS) */
    fun canRegister(): Boolean
    /** every registered beacon, enabled or not (GET /admin/beacons?includeDisabled=true) */
    fun beacons(): List<AdminBeacon>
    /** POST /admin/beacons; returns a short description of the created beacon */
    fun register(body: JsonObject): String
    /** PATCH /admin/beacons/:id (fields, placement, enabled) */
    fun update(beaconId: String, body: JsonObject): AdminBeacon
    /** DELETE /admin/beacons/:id?permanent=true */
    fun delete(beaconId: String)
    fun buildings(): List<AnchorBuilding>
}

data class GeoFix(val latitude: Double, val longitude: Double, val accuracyM: Double?)

enum class RegistrationAccess { CHECKING, ALLOWED, DENIED, SIGNED_OUT, UNREACHABLE }

data class BeaconRegistrationUi(
    val access: RegistrationAccess = RegistrationAccess.CHECKING,
    val scanning: Boolean = false,
    val scanner: BeaconScannerState = BeaconScannerState.Idle,
    val heard: List<HeardBeacon> = emptyList(),
    val form: BeaconRegistrationForm = BeaconRegistrationForm(),
    val errors: Map<String, String> = emptyMap(),
    val message: String? = null,
    val submitting: Boolean = false,
    val buildings: List<AnchorBuilding> = emptyList(),
    /** registered beacons (the edit list) */
    val registered: List<AdminBeacon> = emptyList(),
    /** the beacon being edited; null = registering a new one */
    val editing: AdminBeacon? = null,
)

/**
 * Registration screen logic (admin tooling inside the collector app, docs/BEACON_POSITIONING.md §5.4): survey scan of
 * every nearby iBeacon -> tap fills the form -> current location -> POST /admin/beacons. Independent of collection:
 * its own scanner instance, nothing it does touches the active session. All state is confined to [scope].
 */
class BeaconRegistrationController(
    private val scanner: SurveyScanner,
    private val backend: RegistrationBackend,
    private val currentLocation: suspend () -> GeoFix?,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long,
    /** after a registry change (register, edit, delete): refresh the collector's beacon config */
    private val onRegistered: () -> Unit = {},
) {
    private val _ui = MutableStateFlow(BeaconRegistrationUi())
    val ui: StateFlow<BeaconRegistrationUi> = _ui
    private var registered: Set<String> = emptySet()
    private fun setRegistered(list: List<AdminBeacon>) {
        registered = list.map { it.key }.toSet()
        _ui.value = _ui.value.copy(registered = list, heard = heard.list())
    }
    private val heard = HeardBeacons { it in registered }

    init {
        scanner.onStateChanged = { s -> scope.launch { _ui.value = _ui.value.copy(scanner = s) } }
    }

    /** Screen opened (or signed in again): who may register, what is registered, the building list. */
    fun open() = scope.launch {
        _ui.value = _ui.value.copy(access = RegistrationAccess.CHECKING, message = null)
        val access = try {
            if (backend.canRegister()) RegistrationAccess.ALLOWED else RegistrationAccess.DENIED
        } catch (e: ApiError.Http) {
            when {
                e.code == "POSITIONING_ADMIN_REQUIRED" || e.status == 403 -> RegistrationAccess.DENIED
                e.status == 401 -> RegistrationAccess.SIGNED_OUT
                else -> RegistrationAccess.UNREACHABLE
            }
        } catch (e: Exception) {
            RegistrationAccess.UNREACHABLE
        }
        _ui.value = _ui.value.copy(access = access)
        if (access != RegistrationAccess.ALLOWED) return@launch
        runCatching { setRegistered(backend.beacons()) }
        val buildings = runCatching { backend.buildings() }.getOrDefault(emptyList())
        _ui.value = _ui.value.copy(buildings = buildings, heard = heard.list())
    }

    fun startScan() = scope.launch {
        heard.clear()
        _ui.value = _ui.value.copy(scanning = true, heard = emptyList(), message = null)
        scanner.startSurvey { o -> scope.launch { record(IBeaconFrame(o.uuid, o.major, o.minor, o.measuredPowerDbm ?: -59), o.rssiDbm) } }
    }

    fun stopScan() = scope.launch {
        scanner.stop()
        _ui.value = _ui.value.copy(scanning = false)
    }

    internal fun record(frame: IBeaconFrame, rssi: Int?) {
        heard.add(frame, rssi, nowMs())
        _ui.value = _ui.value.copy(heard = heard.list())
    }

    /** Tap on a heard beacon: identifier and advertised power into the form (the rest is kept; leaves edit mode). */
    fun pick(b: HeardBeacon) = scope.launch {
        _ui.value = _ui.value.copy(editing = null, form = _ui.value.form.copy(uuid = b.uuid.uppercase(Locale.ROOT), major = b.major.toString(),
            minor = b.minor.toString(), measuredPowerDbm = b.measuredPower.toString()), errors = emptyMap(), message = null)
    }

    fun edit(change: (BeaconRegistrationForm) -> BeaconRegistrationForm) = scope.launch {
        _ui.value = _ui.value.copy(form = change(_ui.value.form))
    }

    fun useCurrentLocation() = scope.launch {
        _ui.value = _ui.value.copy(message = "현재 위치를 읽는 중…")
        val fix = runCatching { currentLocation() }.getOrNull()
        _ui.value = if (fix == null) {
            _ui.value.copy(message = "위치를 읽지 못했습니다. 위치 권한·위치 서비스를 확인하세요.")
        } else {
            _ui.value.copy(
                form = _ui.value.form.copy(positionMode = "wgs84", latitude = "%.7f".format(Locale.ROOT, fix.latitude),
                    longitude = "%.7f".format(Locale.ROOT, fix.longitude),
                    horizontalAccuracyM = fix.accuracyM?.let { "${it.coerceIn(1.0, 100.0).toInt()}" } ?: _ui.value.form.horizontalAccuracyM),
                message = "현재 위치 ±${fix.accuracyM?.toInt() ?: "?"} m (실내 GPS는 수십 m 틀릴 수 있습니다)",
            )
        }
    }

    /** Register (new) or save (editing). */
    fun submit() = scope.launch {
        val editing = _ui.value.editing
        val request = if (editing == null) BeaconRegistration.build(_ui.value.form) else BeaconRegistration.buildEdit(_ui.value.form)
        when (request) {
            is RegistrationRequest.Errors -> _ui.value = _ui.value.copy(errors = request.fields, message = "입력을 확인하세요.")
            is RegistrationRequest.Body -> change {
                if (editing == null) {
                    val created = backend.register(request.json)
                    "등록했습니다: $created"
                } else {
                    val saved = backend.update(editing.beaconId, request.json)
                    _ui.value = _ui.value.copy(editing = saved, form = BeaconRegistration.formFrom(saved))
                    "저장했습니다."
                }
            }
        }
    }

    /** Open a registered beacon for editing (its form replaces the current one). */
    fun startEdit(b: AdminBeacon) = scope.launch {
        _ui.value = _ui.value.copy(editing = b, form = BeaconRegistration.formFrom(b), errors = emptyMap(), message = null)
    }

    /** Back to registering a new beacon. */
    fun cancelEdit() = scope.launch {
        _ui.value = _ui.value.copy(editing = null, form = BeaconRegistrationForm(), errors = emptyMap(), message = null)
    }

    /** Disable (leaves the config and fusion, history kept) or enable again. */
    fun setEnabled(enabled: Boolean) = scope.launch {
        val editing = _ui.value.editing ?: return@launch
        change {
            val saved = backend.update(editing.beaconId, buildJsonObject { put("enabled", enabled) })
            _ui.value = _ui.value.copy(editing = saved)
            if (enabled) "다시 사용합니다." else "사용 중지했습니다(기록은 남습니다)."
        }
    }

    /** Permanent delete: observations keep their identifier and show as unregistered again. */
    fun delete() = scope.launch {
        val editing = _ui.value.editing ?: return@launch
        change {
            backend.delete(editing.beaconId)
            _ui.value = _ui.value.copy(editing = null, form = BeaconRegistrationForm())
            "삭제했습니다: ${editing.label ?: "${editing.major} / ${editing.minor}"}"
        }
    }

    /** One registry change: busy flag, server error -> message, then the list and the collector config refresh. */
    private fun change(action: () -> String) {
        _ui.value = _ui.value.copy(errors = emptyMap(), submitting = true, message = null)
        var changed = false
        val message = try {
            action().also { changed = true }
        } catch (e: ApiError.Http) {
            when (e.code) {
                "BEACON_EXISTS" -> "이미 등록된 UUID·Major·Minor입니다. 목록에서 골라 수정하세요."
                "BEACON_NOT_FOUND" -> "이미 삭제된 비콘입니다."
                "POSITIONING_ADMIN_REQUIRED" -> "이 계정은 비콘 등록 권한이 없습니다."
                "VALIDATION_ERROR" -> "서버가 입력을 거절했습니다: ${e.detail ?: e.message}"
                else -> e.detail ?: e.message ?: "HTTP ${e.status}"
            }
        } catch (e: Exception) {
            e.message ?: "서버에 연결하지 못했습니다."
        }
        if (changed) onRegistered()
        runCatching { setRegistered(backend.beacons()) }
        if (_ui.value.editing != null && _ui.value.registered.none { it.beaconId == _ui.value.editing?.beaconId }) {
            _ui.value = _ui.value.copy(editing = null, form = BeaconRegistrationForm()) // deleted elsewhere
        }
        _ui.value = _ui.value.copy(submitting = false, message = message, heard = heard.list())
    }

    fun close() = scope.launch {
        scanner.stop()
        _ui.value = _ui.value.copy(scanning = false)
    }
}
