package hoshi.campustracker

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import hoshi.campustracker.ui.AppRoot
import hoshi.campustracker.ui.CollectActions
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val graph: AppGraph get() = (application as CampusTrackerApplication).graph

    private var startMessage by mutableStateOf<String?>(null)
    private var locationPermission by mutableStateOf("Not Determined")
    private var pendingAction: (() -> Unit)? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        refreshPermissionLabel()
        val action = pendingAction
        pendingAction = null
        if (hasLocation()) {
            action?.invoke()
        } else {
            // A location-type foreground service cannot start without it (§5.2, §12-10).
            startMessage = "Location permission is required to start collection."
        }
    }

    private val actions = object : CollectActions {
        override fun start() = withPermissions {
            val owner = graph.auth.currentOwner ?: run { startMessage = "Sign in before starting a collection."; return@withPermissions }
            val settings = graph.settings.currentBlocking()
            graph.coordinator.startSession(owner.collectorId, owner, settings.motionRate, settings.locationProfile, settings.distanceFilter)
        }

        override fun stop() {
            graph.coordinator.stopSession()
        }

        override fun resume() = withPermissions {
            val owner = graph.auth.currentOwner ?: run { startMessage = "Sign in before resuming a collection."; return@withPermissions }
            graph.coordinator.resumeInterrupted(owner)
        }

        override fun finishInterrupted() {
            val owner = graph.auth.currentOwner ?: run { startMessage = "Sign in before finishing a collection."; return }
            graph.coordinator.finishInterrupted(owner)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        refreshPermissionLabel()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                AppRoot(graph, actions, locationPermission, startMessage)
            }
        }
        // Keep the screen on while a session runs and the app is on screen (iOS isIdleTimerDisabled).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                graph.coordinator.ui.map { it.activeSession != null }.distinctUntilChanged().collect { active ->
                    if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionLabel()
    }

    private fun withPermissions(action: () -> Unit) {
        startMessage = null
        val wanted = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(Manifest.permission.ACTIVITY_RECOGNITION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = wanted.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        // Already-decided optional permissions are not asked again on every Start.
        val ask = missing.filter { it.startsWith("android.permission.ACCESS_") || !graph.permissionHistory.locationRequested }
        if (ask.isEmpty()) {
            if (hasLocation()) action() else startMessage = "Location permission is required to start collection."
            return
        }
        graph.permissionHistory.locationRequested = true
        pendingAction = action
        permissionLauncher.launch(ask.toTypedArray())
    }

    private fun hasLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun refreshPermissionLabel() {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        locationPermission = when {
            fine -> "Authorized"
            coarse -> "Authorized (approximate location only)"
            !graph.permissionHistory.locationRequested -> "Not Determined"
            else -> "Denied"
        }
    }
}
