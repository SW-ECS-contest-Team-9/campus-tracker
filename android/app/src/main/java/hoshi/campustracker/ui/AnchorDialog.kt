package hoshi.campustracker.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import hoshi.campustracker.model.AnchorNeeds
import hoshi.campustracker.model.AnchorRules
import hoshi.campustracker.model.CollectionAnchor
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.net.AnchorNodesResponse
import java.util.Locale

/**
 * Collection anchor for one marker (server `markers/marker-anchor.ts`). Start, End and Entrance ask building → floor →
 * node; stairs ask direction and floors; elevators the floors; ramps the direction. Confirm stays disabled until the
 * anchor is complete ([AnchorRules.isComplete]).
 */
@Composable
fun AnchorDialog(
    type: EventMarkerType,
    /** prefill: the session's current place (or the open stairs/elevator anchor for its end) */
    initial: CollectionAnchor?,
    loadNodes: suspend (buildingId: String?, floor: String?) -> AnchorNodesResponse,
    onConfirm: (CollectionAnchor) -> Unit,
    onDismiss: () -> Unit,
) {
    val needs = AnchorRules.needs(type)
    var anchor by remember(type) { mutableStateOf(prefill(type, initial)) }
    var buildings by remember { mutableStateOf<AnchorNodesResponse?>(null) }
    var nodes by remember { mutableStateOf<AnchorNodesResponse?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }

    if (needs == AnchorNeeds.PLACE) {
        LaunchedEffect(attempt) {
            if (buildings != null) return@LaunchedEffect
            runCatching { loadNodes(null, null) }.onSuccess { buildings = it; error = null }.onFailure { error = it.message ?: "Could not load the buildings." }
        }
        LaunchedEffect(anchor.buildingId, anchor.floor, attempt) {
            nodes = null
            val building = anchor.buildingId ?: return@LaunchedEffect
            if (building != CollectionAnchor.OUTDOOR && anchor.floor == null) return@LaunchedEffect
            loading = true
            runCatching { loadNodes(building, if (building == CollectionAnchor.OUTDOOR) null else anchor.floor) }
                .onSuccess { nodes = it; error = null }
                .onFailure { error = it.message ?: "Could not load the nodes." }
            loading = false
        }
    }
    // a floor without indoor nodes (nothing on that floor in the list) takes building + floor only
    val nodesOnOffer = nodes?.nodes?.isNotEmpty() ?: true
    val complete = AnchorRules.isComplete(type, anchor, nodesOnOffer) && (needs != AnchorNeeds.PLACE || nodes != null)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(titleOf(type)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (needs) {
                    AnchorNeeds.PLACE -> {
                        val list = buildings?.buildings.orEmpty()
                        Picker("Building", list.map { it.buildingId to it.buildingName }, anchor.buildingId) {
                            anchor = anchor.copy(buildingId = it, floor = if (it == CollectionAnchor.OUTDOOR) null else anchor.floor, nodeId = null, nodeLabel = null)
                        }
                        if (anchor.buildingId != null && anchor.buildingId != CollectionAnchor.OUTDOOR) {
                            val withNodes = list.firstOrNull { it.buildingId == anchor.buildingId }?.floorsWithNodes.orEmpty()
                            Picker("Floor", AnchorRules.FLOORS.map { it to if (it in withNodes) "$it · nodes" else it }, anchor.floor) {
                                anchor = anchor.copy(floor = it, nodeId = null, nodeLabel = null)
                            }
                        }
                        if (loading) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                        nodes?.let { r ->
                            if (r.nodes.isEmpty()) {
                                Caption("No mapped node on this floor: building and floor only.")
                            } else {
                                Caption("Node (nearest first)")
                                r.nodes.forEach { n ->
                                    Row(
                                        Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { anchor = anchor.copy(nodeId = n.nodeId, nodeLabel = n.label) },
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        RadioButton(selected = anchor.nodeId == n.nodeId, onClick = { anchor = anchor.copy(nodeId = n.nodeId, nodeLabel = n.label) })
                                        Column {
                                            Text(n.label)
                                            Caption(listOfNotNull(n.floor ?: "floor unknown", n.distanceM?.let { String.format(Locale.US, "%.0f m", it) }).joinToString(" · "))
                                        }
                                    }
                                }
                            }
                        }
                    }
                    AnchorNeeds.STAIRS, AnchorNeeds.RAMP -> {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("up" to "Up", "down" to "Down").forEach { (wire, label) ->
                                FilterChip(selected = anchor.direction == wire, onClick = { anchor = anchor.copy(direction = wire) }, label = { Text(label) })
                            }
                        }
                        if (needs == AnchorNeeds.STAIRS) FloorPair(anchor) { anchor = it.copy(direction = AnchorRules.direction(it.fromFloor, it.toFloor) ?: it.direction) }
                    }
                    AnchorNeeds.ELEVATOR -> FloorPair(anchor) { anchor = it }
                    AnchorNeeds.NONE -> Unit
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { error = null; attempt++ }) { Text("Retry") }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(anchor) }, enabled = complete) { Text(confirmOf(type)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun FloorPair(anchor: CollectionAnchor, onChange: (CollectionAnchor) -> Unit) {
    val floors = AnchorRules.FLOORS.map { it to it }
    Picker("From floor", floors, anchor.fromFloor) { onChange(anchor.copy(fromFloor = it)) }
    Picker("To floor", floors, anchor.toFloor) { onChange(anchor.copy(toFloor = it)) }
}

@Composable
internal fun Picker(label: String, options: List<Pair<String, String>>, selected: String?, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = options.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
            Text("$label: ${options.firstOrNull { it.first == selected }?.second ?: selected ?: "choose"}")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (value, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); open = false }, modifier = Modifier.padding(horizontal = 4.dp))
            }
        }
    }
}

/** Start/End/Entrance begin from the current place; an end marker repeats its open start's floors. */
private fun prefill(type: EventMarkerType, initial: CollectionAnchor?): CollectionAnchor = when (AnchorRules.needs(type)) {
    AnchorNeeds.PLACE -> CollectionAnchor(buildingId = initial?.buildingId, floor = initial?.floor)
    AnchorNeeds.STAIRS, AnchorNeeds.ELEVATOR -> CollectionAnchor(
        direction = initial?.direction,
        fromFloor = initial?.fromFloor ?: initial?.floor,
        toFloor = initial?.toFloor,
    )
    AnchorNeeds.RAMP -> CollectionAnchor(direction = initial?.direction)
    AnchorNeeds.NONE -> CollectionAnchor()
}

private fun titleOf(type: EventMarkerType) = when (type) {
    EventMarkerType.sessionStart -> "Where are you starting?"
    EventMarkerType.sessionEnd -> "Where are you ending?"
    else -> type.title
}

private fun confirmOf(type: EventMarkerType) = when (type) {
    EventMarkerType.sessionStart -> "Start"
    EventMarkerType.sessionEnd -> "Stop"
    EventMarkerType.routeWaypoint -> "Add"
    else -> "Mark"
}
