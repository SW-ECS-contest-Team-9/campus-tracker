import CoreLocation
import SwiftUI
import UIKit

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
            updateUploadOwner()
            // Settled before Start is ever reachable, not during session start (§P0 permission gating).
            coordinator.requestLocationAuthorizationIfNeeded()
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
        .onChange(of: authentication.collectorId) { _ in updateUploadOwner() }
        .onChange(of: authentication.configuration) { _ in updateUploadOwner() }
    }

    /// Gates the upload queue to the collector+server currently signed in, so pending local data
    /// never follows a login or server-address change to the wrong destination (§P0 owner scoping).
    private func updateUploadOwner() {
        coordinator.updateUploadOwner(collectorId: authentication.collectorId, serverKey: authentication.configuration?.ownerKey)
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
    // Default matches the server's current fusion-engine assumption (50 Hz motion); an existing
    // install's own saved choice in UserDefaults still overrides this for returning users.
    @AppStorage("motionSamplingRate") private var motionSamplingRate = MotionSamplingRate.hz50.rawValue
    @AppStorage("locationProfile") private var locationProfile = LocationCollectionProfile.highAccuracy.rawValue
    @AppStorage("locationDistanceFilter") private var locationDistanceFilter = 0.0
    @AppStorage("arkitEnabled") private var arkitEnabled = false
    @AppStorage("arkitPoseRate") private var arkitPoseRate = ARKitPoseRate.hz10.rawValue
    @AppStorage("walkingFrameEnabled") private var walkingFrameEnabled = false
    @State private var showDeniedPermissionAlert = false
    /// the marker whose collection anchor is being picked (Start/Stop use sessionStart/sessionEnd)
    @State private var anchorFor: AnchorRequest?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if coordinator.interruptedCollection != nil {
                    interruptedCollectionSection
                }
                statusSection
                readingsSection
                arkitSection
                walkingFrameSection
                diagnosticsSection
                if coordinator.verticalReminder { verticalReminderSection }
                markerSection
            }
            .padding()
        }
        .navigationTitle("Collection")
        .sheet(item: $anchorFor) { request in
            AnchorPickerView(
                type: request.type,
                initial: [EventMarkerType.stairEnd, .elevatorExit, .rampEnd].contains(request.type)
                    ? (coordinator.openVerticalAnchor ?? coordinator.lastPlace) : coordinator.lastPlace,
                configuration: authentication.configuration,
                location: coordinator.latestLocation.map { (latitude: $0.latitude, longitude: $0.longitude) },
                onConfirm: { anchor in
                    anchorFor = nil
                    switch request.type {
                    case .sessionStart: startCollection(anchor: anchor)
                    case .sessionEnd: coordinator.stopSession(endAnchor: anchor)
                    default: coordinator.addMarker(type: request.type, anchor: anchor)
                    }
                },
                onCancel: { anchorFor = nil })
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(coordinator.activeSession == nil ? "Start" : "Stop") {
                    print("[Start] tapped activeSession=\(coordinator.activeSession != nil)")
                    if coordinator.activeSession == nil {
                        guard authentication.authenticatedCollector != nil else {
                            print("[Start] blocked: no authenticated collector")
                            return
                        }
                        // Permission must already be settled before a session can start — never
                        // mid-start, which used to surface the system prompt after sensors (and
                        // ARKit) had already been told to begin.
                        switch coordinator.locationAuthorization {
                        case .notDetermined:
                            print("[Start] blocked: location authorization not yet determined; requesting")
                            coordinator.requestLocationAuthorizationIfNeeded()
                            return
                        case .denied, .restricted:
                            print("[Start] blocked: location authorization denied/restricted")
                            showDeniedPermissionAlert = true
                            return
                        case .authorizedWhenInUse, .authorizedAlways:
                            break
                        @unknown default:
                            showDeniedPermissionAlert = true
                            return
                        }
                        // the start anchor (building → floor → node) comes first; Start in the sheet begins collection
                        anchorFor = AnchorRequest(type: .sessionStart)
                    } else {
                        print("[Start] asking for the end anchor")
                        anchorFor = AnchorRequest(type: .sessionEnd)
                    }
                }
            }
        }
        .alert("위치 권한이 필요합니다", isPresented: $showDeniedPermissionAlert) {
            Button("설정 열기") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("수집을 시작하려면 위치 권한이 필요합니다. 설정 앱에서 위치 권한을 허용한 뒤 다시 시도하세요.")
        }
    }

    private func startCollection(anchor: CollectionAnchor) {
        guard let collector = authentication.authenticatedCollector else { return }
        print("[Start] authenticated collector=\(collector.collectorId); starting local collection")
        coordinator.startSession(
            collectorId: collector.collectorId,
            serverKey: authentication.configuration?.ownerKey ?? "",
            motionRate: MotionSamplingRate(rawValue: motionSamplingRate) ?? .hz50,
            locationProfile: LocationCollectionProfile(rawValue: locationProfile) ?? .highAccuracy,
            distanceFilter: locationDistanceFilter,
            healthStride: healthStride,
            arkitEnabled: arkitEnabled,
            arkitRate: ARKitPoseRate(rawValue: arkitPoseRate) ?? .hz10,
            walkingFrameEnabled: walkingFrameEnabled,
            startAnchor: anchor
        )
    }

    private var verticalReminderSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Did you change floors?").font(.headline)
            Text("The barometer moved more than 3 m since the last stairs/elevator marker. Mark the stairs or elevator you took.")
                .font(.subheadline)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.2), in: RoundedRectangle(cornerRadius: 12))
    }

    private var captureStateText: String {
        switch coordinator.captureState {
        case .idle: return coordinator.activeSession == nil ? "Ready" : "Recording"
        case .starting: return "Starting…"
        case .recording: return "Recording"
        case .stopping: return "Stopping — saving…"
        case .storageFailure: return "Storage failure — tap Stop to retry"
        }
    }

    private var walkingFrameSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Experimental walking frame")
                .font(.headline)
            if !walkingFrameEnabled {
                Text("Disabled for this session")
                    .foregroundColor(.secondary)
            } else if let snapshot = coordinator.walkingFrameSnapshot {
                Text("State: \(snapshot.status.rawValue)")
                Text(String(format: "Signal confidence: %.2f (internal metric)", snapshot.confidence))
                Text(snapshot.directionResolved ? "Direction sign: externally resolved" : "Direction sign: unresolved (180° ambiguity)")
                Text("Magnetic calibration: \(coordinator.magneticCalibrationQuality.rawValue)")
            } else {
                Text("Waiting for enough motion data…")
                    .foregroundColor(.secondary)
            }
        }
        .font(.caption)
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
            if coordinator.interruptedCollection?.pendingStop != nil {
                Text("Stop was already requested; only finishing is allowed.")
                    .font(.caption)
            }
            HStack {
                Button("Resume") {
                    coordinator.resumeInterruptedCollection(
                        serverKey: authentication.configuration?.ownerKey ?? "",
                        arkitEnabled: arkitEnabled,
                        arkitRate: ARKitPoseRate(rawValue: arkitPoseRate) ?? .hz10
                    )
                }
                .buttonStyle(.borderedProminent)
                .disabled(coordinator.interruptedCollection?.pendingStop != nil)
                Button("Finish as Interrupted", role: .destructive) {
                    coordinator.finishInterruptedCollection(serverKey: authentication.configuration?.ownerKey ?? "")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
    }

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(captureStateText)
                .font(.title2)
                .foregroundColor(coordinator.activeSession == nil ? .primary : .red)
            if let error = coordinator.captureStorageError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
            }
            Text("Collector: \(authentication.authenticatedCollector?.collectorId ?? "—")")
            Text("Session: \(coordinator.activeSession?.id.uuidString ?? "—")")
                .font(.caption)
                .lineLimit(1)
            Text("Location permission: \(authorizationText)")
                .font(.caption)
            // Permission prompts belong before Start, never mid-session (a session is already
            // running by the time this row would otherwise invite another system dialog).
            if coordinator.activeSession == nil {
                if coordinator.locationAuthorization == .authorizedWhenInUse {
                    Button("Allow Background Location") {
                        coordinator.requestAlwaysLocationAuthorization()
                    }
                    .font(.caption)
                }
                if coordinator.accuracyAuthorization == .reducedAccuracy {
                    Text("Precise Location is off — collection will record reduced-accuracy fixes.")
                        .font(.caption)
                        .foregroundColor(.orange)
                    Button("Turn On Precise Location in Settings") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(url)
                    }
                    .font(.caption)
                }
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
            if coordinator.heldUploadCount > 0 {
                Text("Held for another account/server: \(coordinator.heldUploadCount)")
                    .font(.caption)
                    .foregroundColor(.orange)
            }
            if coordinator.quarantinedUploadCount > 0 {
                Text("Quarantined (permanently rejected): \(coordinator.quarantinedUploadCount)")
                    .font(.caption)
                    .foregroundColor(.red)
            }
            if coordinator.unsynchronizedSessionCount > 0 {
                Text("Unsynchronized sessions: \(coordinator.unsynchronizedSessionCount)")
                    .font(.caption)
                    .foregroundColor(.red)
            }
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

    private var arkitSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ARKit Tracking").font(.headline)
            Text("Supported: \(coordinator.arkitSupported ? "Yes" : "No")")
            if coordinator.activeSession == nil {
                // On the Collection screen (not just Settings) so an ARKit-on vs. ARKit-off A/B
                // comparison of the same route doesn't require a trip to Settings between runs.
                Toggle("Enabled for next session", isOn: $arkitEnabled)
                    .disabled(!coordinator.arkitSupported)
            } else {
                Text("Enabled: \(arkitEnabled ? "Yes" : "No")")
            }
            if coordinator.activeSession != nil, arkitEnabled, coordinator.arkitSupported {
                Text("State: \(arkitTrackingStateText)")
                Text("AR Session: \(coordinator.arkitSessionId?.uuidString ?? "—")")
                    .font(.caption)
                    .lineLimit(1)
                Text("Poses collected: \(coordinator.arkitPoseCount)")
                Text("Last pose: \(age(coordinator.arkitLastPoseAt))")
                if coordinator.arkitBackpressurePaused {
                    // Capture was paused instead of dropping stored poses; uploads keep draining.
                    Text("ARKit paused: upload backlog too large (stored poses kept)")
                        .foregroundColor(.orange)
                    Button("Resume ARKit") { coordinator.resumeArkitAfterBackpressure() }
                        .buttonStyle(.bordered)
                }
                if let error = coordinator.arkitError {
                    Text("Error: \(error)")
                        .foregroundColor(.red)
                }
            }
        }
        .font(.caption)
        .padding()
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    private var arkitTrackingStateText: String {
        switch coordinator.arkitTrackingState {
        case .normal: return "Normal"
        case .notAvailable: return "Not Available"
        case .limited:
            switch coordinator.arkitTrackingStateReason {
            case .initializing: return "Limited (Initializing)"
            case .excessiveMotion: return "Limited (Excessive Motion)"
            case .insufficientFeatures: return "Limited (Insufficient Features)"
            case .relocalizing: return "Limited (Relocalizing)"
            case nil: return "Limited"
            }
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
            Text("Pending: \(coordinator.pendingUploadCount) · Held: \(coordinator.heldUploadCount) · Quarantined: \(coordinator.quarantinedUploadCount)")
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
            if let place = coordinator.lastPlace {
                Text("Now: \(place.buildingId == CollectionAnchor.outdoor ? "outside" : [place.buildingId, place.floor].compactMap { $0 }.joined(separator: " "))")
                    .font(.caption)
            }
            if let open = coordinator.openVertical {
                Text("Open: \(open.title) — press its end marker when you arrive").font(.caption).foregroundColor(.orange)
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(EventMarkerType.buttons) { type in
                    Button(type.title) {
                        if AnchorRules.needs(type) == .none { coordinator.addMarker(type: type) } else { anchorFor = AnchorRequest(type: type) }
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
    @EnvironmentObject private var coordinator: CollectionCoordinator
    // Default matches the server's current fusion-engine assumption (50 Hz motion); an existing
    // install's own saved choice in UserDefaults still overrides this for returning users.
    @AppStorage("motionSamplingRate") private var motionSamplingRate = MotionSamplingRate.hz50.rawValue
    @AppStorage("arkitEnabled") private var arkitEnabled = false
    @AppStorage("arkitPoseRate") private var arkitPoseRate = ARKitPoseRate.hz10.rawValue
    @AppStorage("walkingFrameEnabled") private var walkingFrameEnabled = false

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
                // No location accuracy/distance-filter controls here: collection always requests
                // kCLLocationAccuracyBestForNavigation with no distance filter (not configurable).
                Text("Location accuracy: Best for Navigation (fixed, not configurable)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            locationPermissionSection
            arkitSection
            walkingFrameSettingsSection
            healthStrideSection
        }
        .navigationTitle("Settings")
    }

    private var walkingFrameSettingsSection: some View {
        Section(header: Text("Experimental Walking Frame")) {
            Toggle("Estimate unsigned walking axis", isOn: $walkingFrameEnabled)
                .disabled(coordinator.activeSession != nil)
            Text("Uses a gyro/gravity-relative frame and short-window PCA. It can report an unsigned axis and signal quality, not an exact heading or position. Changes apply to the next session.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var locationPermissionSection: some View {
        Section(header: Text("Location Permission")) {
            Text("Authorization: \(authorizationLabel)")
            Text("Precision: \(coordinator.accuracyAuthorization == .fullAccuracy ? "Full" : "Reduced")")
            if coordinator.locationAuthorization == .authorizedWhenInUse {
                Button("Allow Background Location") {
                    coordinator.requestAlwaysLocationAuthorization()
                }
            }
            if coordinator.accuracyAuthorization == .reducedAccuracy {
                Button("Turn On Precise Location in Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
            }
            if coordinator.locationAuthorization == .denied || coordinator.locationAuthorization == .restricted {
                Button("Open Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
            }
        }
    }

    private var authorizationLabel: String {
        switch coordinator.locationAuthorization {
        case .notDetermined: return "Not Determined"
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "When In Use"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        @unknown default: return "Unknown"
        }
    }

    private var arkitSection: some View {
        Section(header: Text("ARKit Tracking")) {
            Toggle("ARKit VIO 수집", isOn: $arkitEnabled)
                .disabled(!coordinator.arkitSupported)
            if !coordinator.arkitSupported {
                Text("이 기기는 ARKit 월드 트래킹을 지원하지 않습니다.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Picker("Pose 전송 주기", selection: $arkitPoseRate) {
                    ForEach(ARKitPoseRate.allCases) { rate in
                        Text(rate.label).tag(rate.rawValue)
                    }
                }
                Text("GPS/IMU 경로와 비교·보정할 ARKit 카메라 pose를 함께 수집합니다. 다음 세션부터 적용됩니다.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
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

/// Sheet item for the anchor picker.
private struct AnchorRequest: Identifiable {
    let type: EventMarkerType
    var id: String { type.rawValue }
}
