package hoshi.campustracker.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import hoshi.campustracker.model.CollectionSession
import java.text.DateFormat
import java.util.Date

@Composable
fun SessionsScreen(sessions: List<CollectionSession>) {
    LazyColumn {
        items(sessions, key = { it.id }) { session ->
            Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                Caption(session.id, singleLine = true)
                Text("${session.collectorId} · ${session.status.name}")
                val c = session.sampleCounts
                Caption("Location ${c.location} · Motion ${c.motion} · Altimeter ${c.altimeter} · Pedometer ${c.pedometer} · Markers ${c.marker}")
                Caption(DateFormat.getDateInstance(DateFormat.LONG).format(Date(session.startedAt)))
            }
            HorizontalDivider()
        }
    }
}
