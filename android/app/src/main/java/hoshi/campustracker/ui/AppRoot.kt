package hoshi.campustracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import hoshi.campustracker.AppGraph
import hoshi.campustracker.auth.AppSettings
import hoshi.campustracker.auth.AuthState
import hoshi.campustracker.model.AnchorNeeds
import hoshi.campustracker.model.AnchorRules
import hoshi.campustracker.model.CollectionAnchor
import hoshi.campustracker.model.CollectionSession
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.model.PlannedRoute
import hoshi.campustracker.model.RouteRules
import hoshi.campustracker.net.AnchorNodesResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Callbacks that need the Activity (runtime permissions). */
interface CollectActions {
    /** [anchor]: the start/end collection anchor the collector picked (node, building, floor); [route]: the declared route */
    fun start(anchor: CollectionAnchor, route: PlannedRoute?)
    fun stop(anchor: CollectionAnchor)
    fun resume()
    fun finishInterrupted()
}

private enum class Tab(val title: String, val glyph: String) { Collect("Collect", "●"), Sessions("Sessions", "▤"), Settings("Settings", "⚙") }

@Composable
fun AppRoot(graph: AppGraph, actions: CollectActions, locationPermission: String, startMessage: String?) {
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val ui by graph.coordinator.ui.collectAsStateWithLifecycle()
    val savedServer by graph.auth.configuration.collectAsStateWithLifecycle()
    val savedCollectorId by graph.auth.savedCollectorId.collectAsStateWithLifecycle()
    when {
        // A running session keeps the collection UI reachable (so Stop stays available) even if auth failed.
        auth is AuthState.Authenticated || ui.activeSession != null -> MainTabs(graph, actions, locationPermission, startMessage)
        auth == AuthState.Unknown -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator()
                Text("Restoring account…")
            }
        }
        else -> Scaffold { padding -> Box(Modifier.padding(padding)) { ServerSetupScreen(graph.auth, auth, savedServer, savedCollectorId) } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainTabs(graph: AppGraph, actions: CollectActions, locationPermission: String, startMessage: String?) {
    var tab by rememberSaveable { mutableStateOf(Tab.Collect) }
    var showServerSettings by rememberSaveable { mutableStateOf(false) }
    var showBeaconRegistration by rememberSaveable { mutableStateOf(false) }
    var sessions by remember { mutableStateOf<List<CollectionSession>>(emptyList()) }
    val scope = rememberCoroutineScope()
    val ui by graph.coordinator.ui.collectAsStateWithLifecycle()
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val socket by graph.socket.state.collectAsStateWithLifecycle()
    val upload by graph.sync.status.collectAsStateWithLifecycle()
    val configuration by graph.auth.configuration.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle(initialValue = AppSettings())
    val beaconUi by graph.beacons.ui.collectAsStateWithLifecycle()
    val savedCollectorId by graph.auth.savedCollectorId.collectAsStateWithLifecycle()
    val reload: () -> Unit = { scope.launch { sessions = withContext(Dispatchers.IO) { graph.coordinator.loadSessions() } } }
    // the marker whose anchor is being picked (Start and Stop open it with sessionStart / sessionEnd)
    var anchorFor by remember { mutableStateOf<EventMarkerType?>(null) }
    // declared route for the next Start (its first point is the start anchor); saved routes live on this phone
    var plannedRoute by remember { mutableStateOf<PlannedRoute?>(null) }
    var planning by remember { mutableStateOf(false) }
    var pickingSaved by remember { mutableStateOf(false) }
    var savedRoutes by remember { mutableStateOf<List<PlannedRoute>>(emptyList()) }
    LaunchedEffect(Unit) { savedRoutes = withContext(Dispatchers.IO) { graph.savedRoutes.load() } }
    val loadNodes: suspend (String?, String?) -> AnchorNodesResponse = { building, floor ->
        val server = configuration ?: throw IllegalStateException("No server configured.")
        val at = ui.latestLocation
        withContext(Dispatchers.IO) { graph.api.anchorNodes(server, building, floor, at?.latitude, at?.longitude) }
    }
    anchorFor?.let { type ->
        AnchorDialog(
            type = type,
            initial = if (type == EventMarkerType.stairEnd || type == EventMarkerType.elevatorExit || type == EventMarkerType.rampEnd) {
                ui.openVerticalAnchor ?: ui.lastPlace
            } else ui.lastPlace,
            loadNodes = loadNodes,
            resolveNode = { id ->
                val server = configuration ?: throw IllegalStateException("No server configured.")
                withContext(Dispatchers.IO) { graph.api.resolveAnchorNode(server, id) }
            },
            onConfirm = { anchor ->
                anchorFor = null
                when (type) {
                    EventMarkerType.sessionStart -> actions.start(anchor, null)
                    EventMarkerType.sessionEnd -> actions.stop(anchor)
                    else -> graph.coordinator.addMarker(type, anchor)
                }
            },
            onDismiss = { anchorFor = null },
        )
    }
    if (planning) {
        RoutePlannerDialog(
            initial = plannedRoute,
            loadNodes = loadNodes,
            onUse = { plannedRoute = it; planning = false },
            onSave = { route ->
                plannedRoute = route
                planning = false
                scope.launch { savedRoutes = withContext(Dispatchers.IO) { graph.savedRoutes.save(route) } }
            },
            onDismiss = { planning = false },
        )
    }
    if (pickingSaved) {
        SavedRoutesDialog(
            routes = savedRoutes,
            onPick = { plannedRoute = it; pickingSaved = false },
            onDelete = { name -> scope.launch { savedRoutes = withContext(Dispatchers.IO) { graph.savedRoutes.delete(name) } } },
            onDismiss = { pickingSaved = false },
        )
    }

    LaunchedEffect(tab) { if (tab == Tab.Sessions) reload() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (tab == Tab.Collect) "Collection" else tab.title) },
                actions = {
                    when (tab) {
                        Tab.Collect -> TextButton(
                            onClick = {
                                val route = plannedRoute
                                val start = route?.let(RouteRules::startAnchor)
                                // a declared route already names the start point: Start goes straight on. The route stays
                                // planned afterwards, so the same walk can be repeated (Clear removes it).
                                if (ui.activeSession == null && route != null && start != null) {
                                    actions.start(start, route)
                                } else {
                                    anchorFor = if (ui.activeSession == null) EventMarkerType.sessionStart else EventMarkerType.sessionEnd
                                }
                            },
                            enabled = !ui.starting,
                        ) { Text(if (ui.activeSession == null) "Start" else "Stop") }
                        Tab.Sessions -> TextButton(onClick = reload) { Text("Refresh") }
                        Tab.Settings -> Unit
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t; if (t != Tab.Settings) showServerSettings = false },
                        icon = { Text(t.glyph, style = MaterialTheme.typography.titleMedium) },
                        label = { Text(t.title) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                Tab.Collect -> CollectScreen(
                    ui = ui,
                    header = CollectHeader(
                        collectorId = (auth as? AuthState.Authenticated)?.collectorId ?: ui.activeSession?.collectorId,
                        server = configuration?.let { "${it.host}:${it.port}" },
                        socket = socket,
                        upload = upload,
                        locationPermission = locationPermission,
                        authProblem = (auth as? AuthState.Failed)?.message,
                        startMessage = startMessage,
                    ),
                    onResume = actions::resume,
                    onFinishInterrupted = actions::finishInterrupted,
                    onMarker = { type -> if (AnchorRules.needs(type) == AnchorNeeds.NONE) graph.coordinator.addMarker(type) else anchorFor = type },
                    routeSection = {
                        val recording = ui.activeSession
                        val declared = recording?.declaredRoute
                        when {
                            declared != null -> RouteProgressCard(declared, ui.routeReached, ui.routeDeviations,
                                onReached = graph.coordinator::reachNextRoutePoint, onOffRoute = graph.coordinator::markOffRoute)
                            recording == null && !ui.starting -> RouteIdleCard(plannedRoute, savedRoutes.size,
                                onPlan = { planning = true }, onSaved = { pickingSaved = true }, onClear = { plannedRoute = null })
                        }
                    },
                )
                Tab.Sessions -> SessionsScreen(sessions)
                Tab.Settings -> if (showServerSettings) {
                    ServerSettingsScreen(graph.auth, configuration, savedCollectorId) { showServerSettings = false }
                } else if (showBeaconRegistration) {
                    BeaconRegistrationScreen(graph.beaconRegistration) { showBeaconRegistration = false }
                } else {
                    SettingsScreen(
                        auth = graph.auth,
                        collectorId = (auth as? AuthState.Authenticated)?.collectorId,
                        settings = settings,
                        onOpenServer = { showServerSettings = true },
                        onMotionRate = { scope.launch { graph.settings.saveSampling(motionRate = it) } },
                        onProfile = { scope.launch { graph.settings.saveSampling(profile = it) } },
                        onDistanceFilter = { scope.launch { graph.settings.saveSampling(distanceFilter = it) } },
                        beacon = beaconUi,
                        onBeaconScanning = { scope.launch { graph.settings.saveBeacon(scanning = it) } },
                        onBeaconUpload = { scope.launch { graph.settings.saveBeacon(upload = it) } },
                        onOpenBeaconRegistration = { showBeaconRegistration = true },
                    )
                }
            }
        }
    }
}
