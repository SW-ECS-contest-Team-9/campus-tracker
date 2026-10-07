package hoshi.campustracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import hoshi.campustracker.auth.AuthState
import hoshi.campustracker.auth.AuthenticationManager
import hoshi.campustracker.net.ServerConfiguration
import hoshi.campustracker.net.ServerScheme
import kotlinx.coroutines.launch

/** Shared form: Server Setup (login) and Settings › Server & Collector. */
@Composable
fun ServerForm(
    auth: AuthenticationManager,
    scheme: ServerScheme,
    onScheme: (ServerScheme) -> Unit,
    host: String,
    onHost: (String) -> Unit,
    port: String,
    onPort: (String) -> Unit,
    collectorId: String,
    onCollectorId: (String) -> Unit,
) {
    Heading("Server")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Protocol", modifier = Modifier.padding(top = 12.dp))
        ServerScheme.entries.forEach { s ->
            FilterChip(selected = scheme == s, onClick = { onScheme(s) }, label = { Text(s.title) })
        }
    }
    OutlinedTextField(
        value = host, onValueChange = onHost, label = { Text("Server address") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = port, onValueChange = onPort, label = { Text("Port") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
    )
    Caption("Use your development computer's LAN IP, not localhost. Example: 192.168.0.15.")
    Heading("Collector")
    OutlinedTextField(
        value = collectorId, onValueChange = { onCollectorId(it.uppercase()) }, label = { Text("Collector ID (for example C03)") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun ServerSetupScreen(auth: AuthenticationManager, state: AuthState, savedServer: ServerConfiguration?, savedCollectorId: String?) {
    var scheme by rememberSaveable { mutableStateOf(savedServer?.scheme ?: ServerScheme.http) }
    var host by rememberSaveable { mutableStateOf(savedServer?.host.orEmpty()) }
    var port by rememberSaveable { mutableStateOf(savedServer?.port?.toString() ?: "3000") }
    var collectorId by rememberSaveable { mutableStateOf(savedCollectorId.orEmpty()) }
    var connectionStatus by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val authenticating = state == AuthState.Authenticating

    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Server Setup", style = MaterialTheme.typography.headlineMedium)
        ServerForm(auth, scheme, { scheme = it }, host, { host = it }, port, { port = it }, collectorId, { collectorId = it })
        OutlinedButton(
            onClick = {
                connectionStatus = "Connecting…"
                scope.launch { connectionStatus = auth.testConnection(scheme, host, port) }
            },
            enabled = !authenticating, modifier = Modifier.fillMaxWidth(),
        ) { Text("Test Connection") }
        Button(onClick = { auth.login(scheme, host, port, collectorId) }, enabled = !authenticating, modifier = Modifier.fillMaxWidth()) {
            if (authenticating) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Login")
        }
        connectionStatus?.let {
            Heading("Connection")
            Text(it)
        }
        if (state is AuthState.Failed) {
            Heading("Login Failed")
            Text(state.message, color = MaterialTheme.colorScheme.error)
        }
    }
}
