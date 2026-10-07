import CoreLocation
import SwiftUI

struct ContentView: View {
    @StateObject private var coordinator = CollectionCoordinator()
    @StateObject private var authentication = AuthenticationManager()
    @StateObject private var healthStride = HealthStrideService()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if authentication.authenticatedCollector != nil {
                AuthenticatedRootView()
                    .environmentObject(coordinator)
                    .environmentObject(authentication)
                    .environmentObject(healthStride)
            } else if authentication.state == .unknown {
                ProgressView("Restoring account…")
            } else {
                ServerLoginView()
                    .environmentObject(authentication)
            }
        }
        .onAppear {
            coordinator.bind(webSocket: authentication.webSocket)
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active:
                coordinator.handleAppState(.foreground)
                healthStride.refreshOnForegroundEntry()
            case .background: coordinator.handleAppState(.background)
            case .inactive: coordinator.handleAppState(.inactive)
            @unknown default: coordinator.handleAppState(.inactive)
            }
        }
    }
}

private struct AuthenticatedRootView: View {
    var body: some View {
        TabView {
            NavigationView {
                CollectionView()
            }
            .tabItem { Label("Collect", systemImage: "record.circle") }

            NavigationView {
                SessionsView()
            }
            .tabItem { Label("Sessions", systemImage: "archivebox") }

            NavigationView {
                SettingsView()
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

private struct CollectionView: View {
    @EnvironmentObject private var coordinator: CollectionCoordinator
    @EnvironmentObject private var authentication: AuthenticationManager
    @EnvironmentObject private var healthStride: HealthStrideService
    @AppStorage("motionSamplingRate") private var motionSamplingRate = MotionSamplingRate.hz20.rawValue
    @AppStorage("locationProfile") private var locationProfile = LocationCollectionProfile.highAccuracy.rawValue
    @AppStorage("locationDistanceFilter") private var locationDistanceFilter = 0.0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if coordinator.interruptedCollection != nil {
                    interruptedCollectionSection
                }
                statusSection
                readingsSection
                diagnosticsSection
                markerSection
            }
            .padding()
        }
        .navigationTitle("Collection")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(coordinator.activeSession == nil ? "Start" : "Stop") {
                    print("[Start] tapped activeSession=\(coordinator.activeSession != nil)")
                    if coordinator.activeSession == nil {
                        guard let collector = authentication.authenticatedCollector else {
                            print("[Start] blocked: no authenticated collector")
                            return
                        }
                        print("[Start] authenticated collector=\(collector.collectorId); starting local collection")
                        coordinator.startSession(
                            collectorId: collector.collectorId,
                            motionRate: MotionSamplingRate(rawValue: motionSamplingRate) ?? .hz20,
                            locationProfile: LocationCollectionProfile(rawValue: locationProfile) ?? .highAccuracy,
                            distanceFilter: locationDistanceFilter,
                            healthStride: healthStride
                        )
                    } else {
                        print("[Start] stopping local collection")
                        coordinator.stopSession()
                    }
                }
            }
        }
    }

    private var interruptedCollectionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Interrupted Collection Found")
                .font(.headline)
            if let recovered = coordinator.interruptedCollection {
                Text("Session: \(recovered.session.id.uuidString)")
                    .font(.caption)
                    .lineLimit(1)
                Text("Started: \(recovered.session.startedAt.formatted())")
                Text("Last sample: \((recovered.lastMotionTimestamp ?? recovered.lastLocationTimestamp)?.formatted() ?? "—")")
            }
            HStack {
                Button("Resume") {
                    coordinator.resumeInterruptedCollection()
                }
                .buttonStyle(.borderedProminent)
                Button("Finish as Interrupted", role: .destructive) {
                    coordinator.finishInterruptedCollection()
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
    }

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(coordinator.activeSession == nil ? "Ready" : "Recording")
                .font(.title2)
                .foregroundColor(coordinator.activeSession == nil ? .primary : .red)
            Text("Collector: \(authentication.authenticatedCollector?.collectorId ?? "—")")
            Text("Session: \(coordinator.activeSession?.id.uuidString ?? "—")")
                .font(.caption)
                .lineLimit(1)
            Text("Location permission: \(authorizationText)")
                .font(.caption)
            if coordinator.locationAuthorization == .authorizedWhenInUse {
                Button("Allow Background Location") {
                    coordinator.requestAlwaysLocationAuthorization()
                }
                .font(.caption)
            }
            Text("Background Collection: \(coordinator.isBackgroundCollectionEnabled ? "Enabled" : "Disabled")")
                .font(.caption)
            Text("Server: \(serverText)")
                .font(.caption)
            Text("WebSocket: \(authentication.webSocket.state.label)")
                .font(.caption)
                .foregroundColor(authentication.webSocket.state == .connected ? .green : .secondary)
            Text("Pending uploads: \(coordinator.pendingUploadCount)")
                .font(.caption)
        }
    }

    private var readingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Latest readings").font(.headline)
            Text("GPS: \(coordinateText)")
            Text("Horizontal accuracy: \(format(coordinator.latestLocation?.horizontalAccuracy)) m")
            Text("Altitude: \(format(coordinator.latestLocation?.altitude)) m")
            Text("Vertical accuracy: \(format(coordinator.latestLocation?.verticalAccuracy)) m")
            Text("Relative altitude: \(format(coordinator.latestRelativeAltitude)) m")
            Text("Step count: \(coordinator.latestStepCount.map(String.init) ?? "—")")
            Text("Samples — Location \(coordinator.uiCounts.location), Motion \(coordinator.uiCounts.motion), Altimeter \(coordinator.uiCounts.altimeter)")
                .font(.caption)
        }
    }

    private var diagnosticsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Collector Diagnostics").font(.headline)
            Text("App State: \(coordinator.appState.rawValue.uppercased())")
            Text("Collection: \(coordinator.activeSession == nil ? "IDLE" : "ACTIVE")")
            Text("Location: \(coordinator.isLocationActive ? "ACTIVE" : "INACTIVE") · last \(age(coordinator.lastLocationTimestamp))")
            Text("Motion: \(coordinator.isMotionActive ? "ACTIVE" : "INACTIVE") · last \(age(coordinator.lastMotionTimestamp))")
            Text("Pedometer: \(coordinator.isPedometerActive ? "ACTIVE" : "INACTIVE") · last \(age(coordinator.lastPedometerTimestamp))")
            Text("Altimeter: \(coordinator.isAltimeterActive ? "ACTIVE" : "INACTIVE") · last \(age(coordinator.lastAltimeterTimestamp))")
            Text("Pending Upload: \(coordinator.pendingUploadCount)")
            Text("Last Persist: \(age(coordinator.lastPersistedAt))")
            if let diagnostics = coordinator.diagnostics {
                Text("Gaps — Location \(diagnostics.locationGaps.count), Motion \(diagnostics.motionGaps.count), Altimeter \(diagnostics.altimeterGaps.count), Pedometer \(diagnostics.pedometerGaps.count)")
                Text("Low Power Observed: \(diagnostics.lowPowerModeObserved ? "Yes" : "No")")
            }
        }
        .font(.caption)
        .padding()
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    private var markerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Markers").font(.headline)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(EventMarkerType.allCases) { type in
                    Button(type.title) {
                        coordinator.addMarker(type: type)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(coordinator.activeSession == nil)
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
            }
        }
    }

    private var coordinateText: String {
        guard let location = coordinator.latestLocation else { return "—" }
        return String(format: "%.6f, %.6f", location.latitude, location.longitude)
    }

    private var authorizationText: String {
        switch coordinator.locationAuthorization {
        case .notDetermined: return "Not Determined"
        case .authorizedAlways, .authorizedWhenInUse: return "Authorized"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        @unknown default: return "Unavailable"
        }
    }

    private var serverText: String {
        guard let configuration = authentication.configuration else { return "—" }
        return "\(configuration.host):\(configuration.port)"
    }

    private func format(_ value: Double?) -> String {
        guard let value = value else { return "—" }
        return String(format: "%.1f", value)
    }

    private func age(_ date: Date?) -> String {
        guard let date else { return "—" }
        return String(format: "%.1fs ago", max(0, Date().timeIntervalSince(date)))
    }
}

private struct SessionsView: View {
    @EnvironmentObject private var coordinator: CollectionCoordinator
    @State private var sessions: [CollectionSession] = []

    var body: some View {
        List(sessions, id: \.id) { session in
            VStack(alignment: .leading, spacing: 4) {
                Text(session.id.uuidString).font(.caption).lineLimit(1)
                Text("\(session.collectorId) · \(session.status.rawValue)")
                Text("Location \(session.sampleCounts.location) · Motion \(session.sampleCounts.motion) · Altimeter \(session.sampleCounts.altimeter) · Pedometer \(session.sampleCounts.pedometer) · Markers \(session.sampleCounts.marker)")
                    .font(.caption)
                Text(session.startedAt, style: .date)
                    .font(.caption)
            }
        }
        .navigationTitle("Sessions")
        .onAppear { reload() }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Refresh") { reload() }
            }
        }
    }

    private func reload() {
        coordinator.loadSessions { sessions = $0 }
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var authentication: AuthenticationManager
    @EnvironmentObject private var healthStride: HealthStrideService
    @AppStorage("motionSamplingRate") private var motionSamplingRate = MotionSamplingRate.hz20.rawValue
    @AppStorage("locationProfile") private var locationProfile = LocationCollectionProfile.highAccuracy.rawValue
    @AppStorage("locationDistanceFilter") private var locationDistanceFilter = 0.0

    var body: some View {
        Form {
            Section(header: Text("Account")) {
                Text("Authenticated as \(authentication.authenticatedCollector?.collectorId ?? "—")")
                NavigationLink("Server & Collector", destination: ServerSettingsView())
                Button("Log Out", role: .destructive) {
                    authentication.logout()
                }
            }
            Section(header: Text("Sampling")) {
                Picker("Motion sampling rate", selection: $motionSamplingRate) {
                    ForEach(MotionSamplingRate.allCases) { rate in
                        Text(rate.label).tag(rate.rawValue)
                    }
                }
                Text("10–20 Hz is recommended for older devices and longer battery life.")
                    .font(.caption)
                Picker("Location profile", selection: $locationProfile) {
                    ForEach(LocationCollectionProfile.allCases) { profile in
                        Text(profile.title).tag(profile.rawValue)
                    }
                }
                Stepper("Distance filter: \(Int(locationDistanceFilter)) m", value: $locationDistanceFilter, in: 0...100, step: 1)
            }
            healthStrideSection
        }
        .navigationTitle("Settings")
    }

    private var healthStrideSection: some View {
        Section(header: Text("보폭 보정")) {
            Toggle("건강 앱 보폭으로 보정", isOn: Binding(
                get: { healthStride.isEnabled },
                set: { healthStride.setEnabled($0) }
            ))
            Text("건강 앱의 걷기 보폭을 이용해 이동거리 추정의 초기값을 보정합니다. 개별 건강 기록 대신 보폭 요약이 추적 서버로 전송됩니다. 연결하지 않아도 기록할 수 있습니다.")
                .font(.caption)
            if healthStride.isEnabled {
                healthStrideStatusView
                Button("보폭 새로고침") {
                    healthStride.refresh()
                }
                Text("새로고침이나 설정 변경은 다음 세션부터 적용됩니다. 진행 중인 세션의 보폭은 바뀌지 않습니다.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    @ViewBuilder
    private var healthStrideStatusView: some View {
        switch healthStride.status {
        case .disabled:
            EmptyView()
        case .loading:
            HStack {
                ProgressView()
                Text("건강 데이터를 확인하는 중…")
            }
            .font(.caption)
        case let .ready(calibration):
            VStack(alignment: .leading, spacing: 2) {
                Text(String(format: "보폭: %.2f m (표본 %d개, %d일)", calibration.stepLengthM, calibration.sampleCount, calibration.observedDays))
                Text("최신 관측: \(calibration.latestSampleAt.formatted())")
            }
            .font(.caption)
        case let .unavailable(message):
            Text(message)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

private struct ServerLoginView: View {
    @EnvironmentObject private var authentication: AuthenticationManager
    @State private var scheme: ServerScheme = .http
    @State private var host = ""
    @State private var port = "3000"
    @State private var collectorID = ""
    @State private var connectionStatus: String?
    @State private var didLoadValues = false

    var body: some View {
        NavigationView {
            Form {
                serverSection
                collectorSection
                Section {
                    Button("Test Connection") {
                        testConnection()
                    }
                    .disabled(isAuthenticating)

                    Button {
                        login()
                    } label: {
                        HStack {
                            Spacer()
                            if isAuthenticating {
                                ProgressView()
                            } else {
                                Text("Login")
                            }
                            Spacer()
                        }
                    }
                    .disabled(isAuthenticating)
                }
                if let connectionStatus = connectionStatus {
                    Section(header: Text("Connection")) {
                        Text(connectionStatus)
                    }
                }
                if case let .failed(message) = authentication.state {
                    Section(header: Text("Login Failed")) {
                        Text(message)
                    }
                }
            }
            .navigationTitle("Server Setup")
            .onAppear(perform: loadValues)
        }
    }

    private var serverSection: some View {
        Section(header: Text("Server")) {
            Picker("Protocol", selection: $scheme) {
                ForEach(ServerScheme.allCases) { scheme in
                    Text(scheme.title).tag(scheme)
                }
            }
            TextField("Server address", text: $host)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            TextField("Port", text: $port)
                .keyboardType(.numberPad)
            Text("On an iPhone, use your development computer's LAN IP, not localhost. Example: 192.168.0.15.")
                .font(.caption)
        }
    }

    private var collectorSection: some View {
        Section(header: Text("Collector")) {
            TextField("Collector ID (for example C03)", text: $collectorID)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
        }
    }

    private var configuration: ServerConfiguration {
        ServerConfiguration(scheme: scheme, host: host, port: Int(port) ?? 0)
    }

    private var isAuthenticating: Bool {
        authentication.state == .authenticating
    }

    private func loadValues() {
        guard !didLoadValues else { return }
        if let saved = authentication.configuration {
            scheme = saved.scheme
            host = saved.host
            port = String(saved.port)
        }
        collectorID = authentication.collectorId ?? ""
        didLoadValues = true
    }

    private func testConnection() {
        connectionStatus = "Connecting…"
        Task {
            if let error = await authentication.testConnection(configuration: configuration) {
                connectionStatus = error
            } else {
                connectionStatus = "Server reachable."
            }
        }
    }

    private func login() {
        connectionStatus = nil
        Task {
            await authentication.login(configuration: configuration, collectorID: collectorID)
        }
    }
}

private struct ServerSettingsView: View {
    @EnvironmentObject private var authentication: AuthenticationManager
    @State private var scheme: ServerScheme = .http
    @State private var host = ""
    @State private var port = "3000"
    @State private var collectorID = ""
    @State private var message: String?
    @State private var didLoadValues = false

    var body: some View {
        Form {
            Section(header: Text("Server")) {
                Picker("Protocol", selection: $scheme) {
                    ForEach(ServerScheme.allCases) { scheme in
                        Text(scheme.title).tag(scheme)
                    }
                }
                TextField("Server address", text: $host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                TextField("Port", text: $port)
                    .keyboardType(.numberPad)
                Text("For a local development server on iPhone, enter the computer's LAN IP address, not localhost.")
                    .font(.caption)
            }
            Section(header: Text("Collector")) {
                TextField("Collector ID", text: $collectorID)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            }
            Section {
                Button("Save Changes") {
                    save()
                }
                Button("Reset Server and Account", role: .destructive) {
                    authentication.resetSettings()
                }
            }
            if let message = message {
                Section {
                    Text(message)
                }
            }
        }
        .navigationTitle("Server & Collector")
        .onAppear(perform: loadValues)
    }

    private var configuration: ServerConfiguration {
        ServerConfiguration(scheme: scheme, host: host, port: Int(port) ?? 0)
    }

    private func loadValues() {
        guard !didLoadValues else { return }
        if let saved = authentication.configuration {
            scheme = saved.scheme
            host = saved.host
            port = String(saved.port)
        }
        collectorID = authentication.collectorId ?? ""
        didLoadValues = true
    }

    private func save() {
        if let error = authentication.saveConfiguration(configuration) {
            message = error
            return
        }
        if let error = authentication.saveCollectorID(collectorID) {
            message = error
            return
        }
        message = "Saved. If server or collector changed, sign in again."
    }
}
