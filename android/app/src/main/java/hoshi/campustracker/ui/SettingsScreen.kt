package hoshi.campustracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import hoshi.campustracker.auth.AppSettings
import hoshi.campustracker.auth.AuthenticationManager
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.MotionSamplingRate
import hoshi.campustracker.net.ServerConfiguration
import hoshi.campustracker.net.ServerScheme
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    auth: AuthenticationManager,
    collectorId: String?,
    settings: AppSettings,
    onOpenServer: () -> Unit,
    onMotionRate: (MotionSamplingRate) -> Unit,
    onProfile: (LocationCollectionProfile) -> Unit,
    onDistanceFilter: (Double) -> Unit,
) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Heading("Account")
        Text("Authenticated as ${collectorId ?: "—"}")
        TextButton(onClick = onOpenServer) { Text("Server & Collector ›") }
        TextButton(onClick = { auth.logout() }) { Text("Log Out", color = MaterialTheme.colorScheme.error) }

        Heading("Sampling")
        Text("Motion sampling rate")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MotionSamplingRate.entries.forEach { rate ->
                FilterChip(selected = settings.motionRate == rate, onClick = { onMotionRate(rate) }, label = { Text(rate.label) })
            }
        }
        Caption("50 Hz is the default and what the server's step detection is designed for. 10–20 Hz saves battery but step detection on the server degrades.")
        Text("Location profile")
        LocationCollectionProfile.entries.forEach { profile ->
            Row(
                Modifier.fillMaxWidth().selectable(selected = settings.locationProfile == profile, onClick = { onProfile(profile) }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = settings.locationProfile == profile, onClick = { onProfile(profile) })
                Text(profile.title)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Distance filter: ${settings.distanceFilter.toInt()} m", modifier = Modifier.weight(1f))
            OutlinedButton(onClick = { onDistanceFilter((settings.distanceFilter - 1).coerceAtLeast(0.0)) }) { Text("−") }
            OutlinedButton(onClick = { onDistanceFilter((settings.distanceFilter + 1).coerceAtMost(100.0)) }) { Text("+") }
        }
    }
}

@Composable
fun ServerSettingsScreen(auth: AuthenticationManager, saved: ServerConfiguration?, savedCollectorId: String?, onBack: () -> Unit) {
    var scheme by rememberSaveable { mutableStateOf(saved?.scheme ?: ServerScheme.http) }
    var host by rememberSaveable { mutableStateOf(saved?.host.orEmpty()) }
    var port by rememberSaveable { mutableStateOf(saved?.port?.toString() ?: "3000") }
    var collectorId by rememberSaveable { mutableStateOf(savedCollectorId.orEmpty()) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onBack) { Text("‹ Settings") }
        ServerForm(auth, scheme, { scheme = it }, host, { host = it }, port, { port = it }, collectorId, { collectorId = it })
        Button(onClick = { scope.launch { message = auth.saveServerSettings(scheme, host, port, collectorId) } }, modifier = Modifier.fillMaxWidth()) {
            Text("Save Changes")
        }
        message?.let { Text(it) }
        OutlinedButton(onClick = { auth.reset() }, modifier = Modifier.fillMaxWidth()) {
            Text("Reset Server and Account", color = MaterialTheme.colorScheme.error)
        }
    }
}
