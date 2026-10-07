package hoshi.campustracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import hoshi.campustracker.collection.CollectorUiState
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.net.ConnectionState
import hoshi.campustracker.sync.UploadStatus
import java.text.DateFormat
import java.util.Date
import java.util.Locale

data class CollectHeader(
    val collectorId: String?,
    val server: String?,
    val socket: ConnectionState,
    val upload: UploadStatus,
    val locationPermission: String,
    val authProblem: String?,
    val startMessage: String?,
)

@Composable
fun CollectScreen(
    ui: CollectorUiState,
    header: CollectHeader,
    onResume: () -> Unit,
    onFinishInterrupted: () -> Unit,
    onMarker: (EventMarkerType) -> Unit,
) {
    val now = ui.publishedAtMs
    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        header.authProblem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        header.startMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        ui.interrupted?.let { recovered ->
            SectionCard(background = Color(0x26FF9800)) {
                Heading("Interrupted Collection Found")
                Caption("Session: ${recovered.session.id}", singleLine = true)
                Text("Started: ${formatDateTime(recovered.session.startedAt)}")
                Text("Last sample: ${(recovered.lastMotionTimestamp ?: recovered.lastLocationTimestamp)?.let(::formatDateTime) ?: "—"}")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onResume) { Text("Resume") }
                    OutlinedButton(onClick = onFinishInterrupted) { Text("Finish as Interrupted", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        SectionCard {
            val recording = ui.activeSession != null
            Text(
                if (recording) "Recording" else if (ui.starting) "Starting…" else "Ready",
                style = MaterialTheme.typography.headlineSmall,
                color = if (recording) Color.Red else MaterialTheme.colorScheme.onSurface,
            )
            Text("Collector: ${header.collectorId ?: "—"}")
            Caption("Session: ${ui.activeSession?.id ?: "—"}", singleLine = true)
            Caption("Location permission: ${header.locationPermission}")
            Caption("Background Collection: ${if (ui.backgroundCollectionEnabled) "Enabled" else "Disabled"}")
            Caption("Server: ${header.server ?: "—"}")
            Caption("WebSocket: ${header.socket.label}", color = if (header.socket == ConnectionState.Connected) Color(0xFF2E7D32) else Color.Gray)
            Caption("Pending uploads: ${header.upload.pending}")
            if (header.upload.heldForOtherOwner > 0) Caption("Held for another collector/server: ${header.upload.heldForOtherOwner}")
        }
        SectionCard {
            Heading("Latest readings")
            val location = ui.latestLocation
            Text("GPS: ${location?.let { String.format(Locale.US, "%.6f, %.6f", it.latitude, it.longitude) } ?: "—"}")
            Text("Horizontal accuracy: ${formatOne(location?.horizontalAccuracy)} m")
            Text("Altitude: ${formatOne(location?.altitude)} m")
            Text("Vertical accuracy: ${formatOne(location?.verticalAccuracy)} m")
            Text("Relative altitude: ${formatOne(ui.latestRelativeAltitude)} m")
            Text("Step count: ${ui.latestStepCount?.toString() ?: "—"}")
            Caption("Samples — Location ${ui.counts.location}, Motion ${ui.counts.motion}, Altimeter ${ui.counts.altimeter}")
        }
        SectionCard(background = Color(0x1A808080)) {
            Heading("Collector Diagnostics")
            Caption("App State: ${ui.appState.wire}")
            Caption("Collection: ${if (ui.activeSession == null) "IDLE" else "ACTIVE"}")
            Caption("Location: ${active(ui.locationActive)} · last ${ageText(ui.lastLocationMs, now)}")
            Caption("Motion: ${active(ui.motionActive)} · last ${ageText(ui.lastMotionMs, now)}")
            Caption("Pedometer: ${active(ui.pedometerActive)} · last ${ageText(ui.lastPedometerMs, now)}")
            Caption("Altimeter: ${active(ui.altimeterActive)} · last ${ageText(ui.lastAltimeterMs, now)}")
            Caption("Pending Upload: ${header.upload.pending}")
            Caption("Last Persist: ${ageText(ui.lastPersistedMs, now)}")
            ui.diagnostics?.let { d ->
                Caption("Gaps — Location ${d.locationGaps.count}, Motion ${d.motionGaps.count}, Altimeter ${d.altimeterGaps.count}, Pedometer ${d.pedometerGaps.count}")
                Caption("Low Power Observed: ${if (d.lowPowerModeObserved) "Yes" else "No"}")
            }
            Caption("Quarantined uploads: ${header.upload.quarantined}")
        }
        SectionCard {
            Heading("Markers")
            EventMarkerType.entries.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                    row.forEach { type ->
                        Button(
                            onClick = { onMarker(type) }, enabled = ui.activeSession != null,
                            modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                            colors = ButtonDefaults.buttonColors(),
                        ) { Text(type.title) }
                    }
                    if (row.size == 1) androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

private fun active(value: Boolean) = if (value) "ACTIVE" else "INACTIVE"

fun formatDateTime(epochMs: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM).format(Date(epochMs))
