package hoshi.campustracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import hoshi.campustracker.model.AnchorRules
import hoshi.campustracker.model.CollectionAnchor
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.model.PlannedRoute
import hoshi.campustracker.model.RoutePoint
import hoshi.campustracker.model.RouteRules
import hoshi.campustracker.model.RouteSegment
import hoshi.campustracker.net.AnchorNodesResponse

/** Before Start: the declared route (사용자 지정 길) or a free walk. */
@Composable
fun RouteIdleCard(route: PlannedRoute?, savedCount: Int, onPlan: () -> Unit, onSaved: () -> Unit, onClear: () -> Unit) {
    SectionCard {
        Heading("Declared route")
        if (route == null) {
            Caption("None: free walk. Plan the route first, then walk it; Start uses its first point.")
        } else {
            Text(RouteRules.describe(route))
            Caption("${route.points.size} points${route.name?.let { " · saved as \"$it\"" } ?: ""}")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPlan) { Text(if (route == null) "Plan route" else "Edit") }
            OutlinedButton(onClick = onSaved, enabled = savedCount > 0) { Text("Saved ($savedCount)") }
            if (route != null) TextButton(onClick = onClear) { Text("Clear") }
        }
    }
}

/** While recording a declared route: where the collector is on it, "reached the next point" and "여기서 벗어남". */
@Composable
fun RouteProgressCard(route: PlannedRoute, reached: Int, deviations: Int, onReached: () -> Unit, onOffRoute: () -> Unit) {
    val next = RouteRules.next(route, reached)
    SectionCard(background = Color(0x1A2196F3)) {
        Heading("Route ${reached + 1}/${route.points.size}")
        Caption(RouteRules.describe(route))
        if (next == null) {
            Text("Last point reached. Press Stop at the end point.")
        } else {
            RouteRules.describeSegment(RouteRules.segment(route, reached))?.let { Text("Then: $it", color = Color(0xFFE65100)) }
            Text("Next: ${RouteRules.describePoint(next)}")
        }
        if (deviations > 0) Caption("Off-route marks: $deviations", color = MaterialTheme.colorScheme.error)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            Button(onClick = onReached, enabled = next != null, modifier = Modifier.weight(1f).heightIn(min = 44.dp)) { Text("Reached next") }
            OutlinedButton(onClick = onOffRoute, modifier = Modifier.weight(1f).heightIn(min = 44.dp)) {
                Text("여기서 벗어남", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/**
 * Plan the route: points in walking order (building → floor → node, the anchor picker), and for each leg walk,
 * 계단 상행/하행 or 승강기 n층→m층. Use stays disabled until [RouteRules.isComplete]; Save also needs a name.
 */
@Composable
fun RoutePlannerDialog(
    initial: PlannedRoute?,
    loadNodes: suspend (buildingId: String?, floor: String?) -> AnchorNodesResponse,
    onUse: (PlannedRoute) -> Unit,
    onSave: (PlannedRoute) -> Unit,
    onDismiss: () -> Unit,
) {
    var route by remember { mutableStateOf(initial ?: PlannedRoute()) }
    var name by remember { mutableStateOf(initial?.name.orEmpty()) }
    var adding by remember { mutableStateOf(false) }
    val complete = RouteRules.isComplete(route)

    if (adding) {
        val last = route.points.lastOrNull()
        AnchorDialog(
            type = EventMarkerType.routeWaypoint,
            initial = last?.let { CollectionAnchor(buildingId = it.buildingId, floor = it.floor) },
            loadNodes = loadNodes,
            onConfirm = { a ->
                adding = false
                val nodeId = a.nodeId ?: return@AnchorDialog
                route = RouteRules.addPoint(route, RoutePoint(nodeId, a.nodeLabel ?: nodeId.take(8), a.buildingId, a.floor))
            },
            onDismiss = { adding = false },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Plan the route") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (route.points.isEmpty()) Caption("Add the start point first, then the points you will pass, then the end point.")
                route.points.forEachIndexed { i, p ->
                    if (i > 0) LegEditor(RouteRules.segment(route, i - 1)) { route = RouteRules.setSegment(route, i - 1, it) }
                    val role = when (i) { 0 -> "Start"; route.points.size - 1 -> "End"; else -> "Via $i" }
                    Text("$role: ${listOfNotNull(p.buildingId?.takeIf { it != CollectionAnchor.OUTDOOR }, RouteRules.describePoint(p)).joinToString(" ")}")
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { adding = true }, enabled = route.points.size < RouteRules.MAX_POINTS) { Text("Add point") }
                    if (route.points.isNotEmpty()) TextButton(onClick = { route = RouteRules.removeLastPoint(route) }) { Text("Remove last") }
                }
                OutlinedTextField(value = name, onValueChange = { name = it.take(60) }, label = { Text("Name (to save)") }, singleLine = true)
            }
        },
        confirmButton = {
            Row {
                TextButton(onClick = { onSave(route.copy(name = name.trim())) }, enabled = complete && name.isNotBlank()) { Text("Save & use") }
                TextButton(onClick = { onUse(route.copy(name = name.trim().ifEmpty { null })) }, enabled = complete) { Text("Use") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun LegEditor(segment: RouteSegment, onChange: (RouteSegment) -> Unit) {
    Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // two rows of two: four chips do not fit a dialog at phone width
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(selected = segment.mode == RouteSegment.WALK, onClick = { onChange(RouteSegment()) }, label = { Text("Walk") })
            FilterChip(selected = segment.mode == RouteSegment.ELEVATOR, onClick = { onChange(RouteSegment(RouteSegment.ELEVATOR)) }, label = { Text("승강기") })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("up" to "계단 상행", "down" to "계단 하행").forEach { (direction, label) ->
                FilterChip(
                    selected = segment.mode == RouteSegment.STAIRS && segment.direction == direction,
                    onClick = { onChange(RouteSegment(RouteSegment.STAIRS, direction = direction)) }, label = { Text(label) },
                )
            }
        }
        if (segment.mode == RouteSegment.ELEVATOR) {
            val floors = AnchorRules.FLOORS.map { it to it }
            Picker("From floor", floors, segment.fromFloor) { onChange(segment.copy(fromFloor = it)) }
            Picker("To floor", floors, segment.toFloor) { onChange(segment.copy(toFloor = it)) }
        }
        if (!RouteRules.isSegmentComplete(segment)) Caption("Choose both floors.", color = MaterialTheme.colorScheme.error)
    }
}

/** Saved routes (this phone): pick one to use, or delete it. */
@Composable
fun SavedRoutesDialog(routes: List<PlannedRoute>, onPick: (PlannedRoute) -> Unit, onDelete: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Saved routes") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (routes.isEmpty()) Caption("No saved route.")
                routes.forEach { r ->
                    Column {
                        Text(r.name ?: "—", style = MaterialTheme.typography.titleSmall)
                        Caption(RouteRules.describe(r))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { onPick(r) }) { Text("Use") }
                            TextButton(onClick = { r.name?.let(onDelete) }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
