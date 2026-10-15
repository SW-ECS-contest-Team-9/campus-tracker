package hoshi.campustracker.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import hoshi.campustracker.collection.BeaconRegistrationController
import hoshi.campustracker.collection.RegistrationAccess
import hoshi.campustracker.positioning.BeaconPermissions
import hoshi.campustracker.positioning.BeaconRegistrationForm
import hoshi.campustracker.positioning.BeaconScannerState

/** Beacon registration (docs/BEACON_POSITIONING.md §5.4): survey scan of nearby iBeacons, manual entry, current location. */
@Composable
fun BeaconRegistrationScreen(controller: BeaconRegistrationController, onBack: () -> Unit) {
    val ui by controller.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { pending?.invoke(); pending = null }
    fun withPermissions(wanted: List<String>, action: () -> Unit) {
        val missing = wanted.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) action() else { pending = action; launcher.launch(missing.toTypedArray()) }
    }
    BackHandler(onBack = onBack)
    LaunchedEffect(Unit) { controller.open() }
    DisposableEffect(Unit) { onDispose { controller.close() } }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onBack) { Text("‹ Settings") }
        Heading("비콘 등록")
        when (ui.access) {
            RegistrationAccess.CHECKING -> Caption("권한 확인 중…")
            RegistrationAccess.DENIED -> Notice("이 계정은 비콘 등록 권한이 없습니다. 서버 .env의 POSITIONING_ADMIN_COLLECTORS에 계정 코드를 추가하세요.")
            RegistrationAccess.SIGNED_OUT -> Notice("로그인이 필요합니다.")
            RegistrationAccess.UNREACHABLE -> Notice("서버에 연결하지 못했습니다.")
            RegistrationAccess.ALLOWED -> Unit
        }
        if (ui.access != RegistrationAccess.ALLOWED) {
            OutlinedButton(onClick = { controller.open() }) { Text("다시 확인") }
            return@Column
        }

        Text("주변 비콘 검색", style = MaterialTheme.typography.titleSmall)
        Caption("Bluetooth·위치 권한을 허용하면 UUID와 관계없이 주변 iBeacon을 모두 찾습니다. 비콘에 가까이(1~2 m) 가면 맨 위에 나옵니다. 누르면 아래 양식에 채워집니다.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { withPermissions(BeaconPermissions.required()) { controller.startScan() } }, enabled = !ui.scanning) { Text("검색 시작") }
            OutlinedButton(onClick = { controller.stopScan() }, enabled = ui.scanning) { Text("중지") }
        }
        scannerMessage(ui.scanner)?.let { Caption(it) }
        if (ui.scanning && ui.heard.isEmpty()) Caption("검색 중…")
        ui.heard.forEach { b ->
            Card(
                Modifier.fillMaxWidth().clickable(enabled = !b.registered) { controller.pick(b) },
                colors = CardDefaults.cardColors(containerColor = if (b.registered) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(10.dp)) {
                    Text(b.uuid, style = MaterialTheme.typography.bodySmall)
                    Text("Major ${b.major} · Minor ${b.minor}")
                    Caption("${b.lastRssi ?: "—"} dBm (최대 ${b.maxRssi ?: "—"}) · 1 m ${b.measuredPower} dBm · ${b.count}회 · ${if (b.registered) "등록됨" else "눌러서 채우기"}")
                }
            }
        }

        Text("등록 정보", style = MaterialTheme.typography.titleSmall)
        val f = ui.form
        FormField("UUID", f.uuid, ui.errors["uuid"]) { v -> controller.edit { it.copy(uuid = v) } }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FormField("Major", f.major, ui.errors["major"], Modifier.weight(1f), KeyboardType.Number) { v -> controller.edit { it.copy(major = v) } }
            FormField("Minor", f.minor, ui.errors["minor"], Modifier.weight(1f), KeyboardType.Number) { v -> controller.edit { it.copy(minor = v) } }
        }
        FormField("1 m 송신 세기(dBm)", f.measuredPowerDbm, ui.errors["measuredPowerDbm"], keyboard = KeyboardType.Number) { v -> controller.edit { it.copy(measuredPowerDbm = v) } }
        FormField("이름", f.label, null) { v -> controller.edit { it.copy(label = v) } }

        Text("설치 위치 (비우면 위치 없이 등록)", style = MaterialTheme.typography.titleSmall)
        FormField("건물 ID (바깥이면 outdoor)", f.buildingId, ui.errors["buildingId"]) { v -> controller.edit { it.copy(buildingId = v) } }
        if (ui.buildings.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ui.buildings.take(30).forEach { b ->
                    FilterChip(selected = f.buildingId == b.buildingId, onClick = { controller.edit { it.copy(buildingId = b.buildingId) } }, label = { Text(b.buildingName) })
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FormField("층 (3F / B1)", f.floor, ui.errors["floor"], Modifier.weight(1f)) { v -> controller.edit { it.copy(floor = v) } }
            FormField("층 바닥 높이(해발 m)", f.floorHeightM, ui.errors["floorHeightM"], Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(floorHeightM = v) } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = f.positionMode == "wgs84", onClick = { controller.edit { it.copy(positionMode = "wgs84") } }, label = { Text("위도·경도") })
            FilterChip(selected = f.positionMode == "grid", onClick = { controller.edit { it.copy(positionMode = "grid") } }, label = { Text("EPSG:5186") })
            OutlinedButton(onClick = { withPermissions(listOf(Manifest.permission.ACCESS_FINE_LOCATION)) { controller.useCurrentLocation() } }) { Text("현재 위치") }
        }
        if (f.positionMode == "grid") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FormField("X (m)", f.x, ui.errors["x"], Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(x = v) } }
                FormField("Y (m)", f.y, ui.errors["y"], Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(y = v) } }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FormField("위도", f.latitude, ui.errors["latitude"], Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(latitude = v) } }
                FormField("경도", f.longitude, ui.errors["longitude"], Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(longitude = v) } }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FormField("바닥에서 높이(m)", f.mountAboveFloorM, null, Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(mountAboveFloorM = v) } }
            FormField("설치 높이(해발 m)", f.z, ui.errors["z"], Modifier.weight(1f), KeyboardType.Decimal) { v -> controller.edit { it.copy(z = v) } }
        }
        Caption("설치 높이를 비우면 층 바닥 높이 + 바닥에서 높이로 계산합니다.")
        FormField("위치 정확도(m)", f.horizontalAccuracyM, ui.errors["horizontalAccuracyM"], keyboard = KeyboardType.Decimal) { v -> controller.edit { it.copy(horizontalAccuracyM = v) } }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { controller.submit() }, enabled = !ui.submitting) { Text(if (ui.submitting) "등록 중…" else "등록") }
            OutlinedButton(onClick = { controller.edit { BeaconRegistrationForm() } }) { Text("비우기") }
        }
        ui.message?.let { Text(it) }
    }
}

@Composable
private fun FormField(label: String, value: String, error: String?, modifier: Modifier = Modifier,
    keyboard: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true, isError = error != null,
        modifier = if (modifier == Modifier) Modifier.fillMaxWidth() else modifier, // alone on a row: full width
        supportingText = error?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
    )
}

@Composable
private fun Notice(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error)
}

private fun scannerMessage(s: BeaconScannerState): String? = when (s) {
    is BeaconScannerState.PermissionDenied -> "권한이 거부되었습니다: ${s.missing.joinToString { it.substringAfterLast('.') }}"
    BeaconScannerState.BluetoothOff -> "Bluetooth가 꺼져 있습니다."
    BeaconScannerState.LocationOff -> "위치 서비스가 꺼져 있습니다(BLE 검색에 필요)."
    BeaconScannerState.Unsupported -> "이 기기는 BLE 검색을 지원하지 않습니다."
    is BeaconScannerState.Failed -> "검색 실패: ${s.reason}"
    else -> null
}
