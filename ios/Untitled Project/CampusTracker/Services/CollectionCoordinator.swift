import ARKit
import Combine
import CoreLocation
import CoreMotion
import Foundation
import UIKit

/// UI + lifecycle commands only. Raw samples never pass through the MainActor: each sensor
/// callback submits an immutable DTO to its stream's ingress, `CollectionCore` processes and
/// commits it to SQLite, and the upload engine is told about committed ledger items.
@MainActor
final class CollectionCoordinator: NSObject, ObservableObject {
    enum CaptureLifecycleState: String {
        case idle, starting, recording, stopping, storageFailure
    }

    @Published private(set) var activeSession: CollectionSession?
    @Published private(set) var captureState: CaptureLifecycleState = .idle
    @Published private(set) var capabilities = SensorCapabilityDetector.detect()
    @Published private(set) var latestLocation: LocationSample?
    @Published private(set) var latestRelativeAltitude: Double?
    @Published private(set) var latestStepCount: Int?
    @Published private(set) var uiCounts = SampleCounts()
    @Published private(set) var durableCounts = SampleCounts()
    @Published private(set) var locationAuthorization: CLAuthorizationStatus
    @Published private(set) var accuracyAuthorization: CLAccuracyAuthorization
    @Published private(set) var pendingUploadCount = 0
    @Published private(set) var heldUploadCount = 0
    @Published private(set) var quarantinedUploadCount = 0
    @Published private(set) var unsynchronizedSessionCount = 0
    @Published private(set) var appState: CollectorAppState = .foreground
    @Published private(set) var interruptedCollection: ActiveCollectionState?
    @Published private(set) var lastPersistedAt: Date?
    @Published private(set) var diagnostics: CollectionDiagnostics?
    @Published private(set) var arkitSupported = ARKitTrackingService.isSupported
    @Published private(set) var arkitTrackingState: ARKitTrackingState = .notAvailable
    @Published private(set) var arkitTrackingStateReason: ARKitTrackingStateReason?
    @Published private(set) var arkitSessionId: UUID?
    @Published private(set) var arkitPoseCount = 0
    @Published private(set) var arkitLastPoseAt: Date?
    @Published private(set) var arkitError: String?
    @Published private(set) var arkitBackpressurePaused = false
    @Published private(set) var walkingFrameSnapshot: WalkingFrameSnapshot?
    @Published private(set) var magneticCalibrationQuality: MagneticCalibrationQuality = .unavailable
    @Published private(set) var captureStorageError: String?
    @Published private(set) var uploadStorageError: String?
    /// Collection anchors: the session's current place (prefills the pickers), the open vertical
    /// marker (stairStart / elevatorBoard / rampStart without its end) and its anchor.
    @Published private(set) var lastPlace: CollectionAnchor?
    @Published private(set) var openVertical: EventMarkerType?
    @Published private(set) var openVerticalAnchor: CollectionAnchor?
    /// relative altitude at the last vertical anchor (start, stair/elevator/ramp end, entrance)
    @Published private(set) var verticalReference: Double?

    let store: CollectionStore
    private let core: CollectionCore
    private let locationService = LocationService()
    private let motionService = MotionService()
    private let altimeterService = AltimeterService()
    private let absoluteAltitudeService = AbsoluteAltitudeService()
    private let pedometerService = PedometerService()
    private let arkitTrackingService = ARKitTrackingService()
    private let clockFactory: () throws -> TrackingClockAnchor
    private let capabilityDetector: () -> SensorCapabilities
    private let startsHardwareSensors: Bool
    private let appStateBox = CaptureAppStateBox()
    private var uploadEngine: TelemetryUploadEngine?
    private var contexts: [CaptureStream: TrackingCaptureContext] = [:]
    private var lastPreparedClocks: SensorRunClocks?
    private var runtimeState: ActiveCollectionState?
    private var appStateChangedAt = Date()
    private var motionStallReported = false
    private var altimeterStallReported = false
    private var arkitEnabledSetting = false
    private var arkitRateSetting: ARKitPoseRate = .hz10
    private var uploadPeak = 0

    var isBackgroundCollectionEnabled: Bool { activeSession != nil && locationService.isActive }
    /// The barometer moved more than 3 m since the last vertical anchor and no stairs/elevator
    /// marker is open: the collector probably changed floors without marking it.
    var verticalReminder: Bool {
        guard activeSession != nil, openVertical == nil, let reference = verticalReference, let altitude = latestRelativeAltitude else { return false }
        return abs(altitude - reference) > AnchorRules.verticalReminderMeters
    }
    var isLocationActive: Bool { locationService.isActive }
    var isMotionActive: Bool { motionService.isActive }
    var isAltimeterActive: Bool { altimeterService.isActive }
    var isAbsoluteAltitudeActive: Bool { absoluteAltitudeService.isActive }
    var isPedometerActive: Bool { pedometerService.isActive }
    var isArkitActive: Bool { arkitTrackingService.isActive }
    var lastLocationTimestamp: Date? { runtimeState?.lastLocationTimestamp }
    var lastMotionTimestamp: Date? { runtimeState?.lastMotionTimestamp }
    var lastAltimeterTimestamp: Date? { runtimeState?.lastAltimeterTimestamp }
    var lastPedometerTimestamp: Date? { runtimeState?.lastPedometerTimestamp }
    var uploadEngineForTesting: TelemetryUploadEngine? { uploadEngine }

    /// - Parameters:
    ///   - capabilityDetector: sensor availability (injectable for tests).
    ///   - startsHardwareSensors: `false` opens the same ingress contexts without starting
    ///     Core Location / Core Motion / ARKit, so tests drive the real admission → core → SQLite
    ///     path with synthetic DTOs only.
    init(store: CollectionStore? = nil,
         coreConfiguration: CollectionCoreConfiguration = .init(),
         clockFactory: @escaping () throws -> TrackingClockAnchor = TrackingClockAnchor.captureNominal,
         capabilityDetector: (() -> SensorCapabilities)? = nil,
         startsHardwareSensors: Bool = true) {
        let store = store ?? CollectionStore()
        self.store = store
        self.core = CollectionCore(store: store, configuration: coreConfiguration)
        self.clockFactory = clockFactory
        self.capabilityDetector = capabilityDetector ?? { SensorCapabilityDetector.detect() }
        self.startsHardwareSensors = startsHardwareSensors
        self.locationAuthorization = locationService.authorizationStatus
        self.accuracyAuthorization = locationService.accuracyAuthorization
        super.init()
        core.setEventHandler { [weak self] event in
            DispatchQueue.main.async { self?.handle(event) }
        }
        configureCallbacks()
        loadRecoverableCollection()
    }

    /// A DB row still `recording` (process died) is offered for Resume/Finish; `stopping` (Stop was
    /// requested and persisted) is never resumed, only finished.
    private func loadRecoverableCollection() {
        store.async({ try $0.sessions(in: [.recording, .stopping]) }) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(sessions):
                guard self.activeSession == nil, let stored = sessions.first, var snapshot = stored.snapshot else { return }
                snapshot.diagnostics.wasInterrupted = true
                if let intent = stored.stopIntent, snapshot.pendingStop == nil { snapshot.apply(intent) }
                self.interruptedCollection = snapshot
                print("[Diagnostics] INTERRUPTED_COLLECTION_FOUND session=\(stored.id.uuidString) state=\(stored.captureState.rawValue)")
            case let .failure(error):
                // Never continue with an empty store: original files are preserved by the store.
                self.captureStorageError = "STORE_UNAVAILABLE: \(error)"
            }
        }
    }

    private func prepareSensorRunClocks() throws -> SensorRunClocks {
        // All three anchors are built and validated before any is used; a failure leaves nothing
        // half-initialized.
        let clocks = SensorRunClocks(motion: try clockFactory(), altimeter: try clockFactory(),
                                     absoluteAltitude: try clockFactory(), arkit: try clockFactory())
        lastPreparedClocks = clocks
        return clocks
    }

    func bind(webSocket: RawWebSocketConnectionManager) {
        bind(socket: webSocket)
    }

    func bind(socket: CollectorSocket) {
        guard uploadEngine == nil else { return }
        let engine = TelemetryUploadEngine(webSocket: socket, store: store)
        engine.onPendingCountChanged = { [weak self] count in self?.updatePendingCount(count) }
        engine.onQuarantinedCountChanged = { [weak self] count in self?.quarantinedUploadCount = count }
        engine.onHeldCountChanged = { [weak self] count in self?.heldUploadCount = count }
        engine.onUnsynchronizedCountChanged = { [weak self] count in self?.unsynchronizedSessionCount = count }
        engine.onStorageError = { [weak self] message in self?.uploadStorageError = message }
        engine.onServerSessionStarted = { [weak self] localSessionID, serverSessionID in
            guard var session = self?.activeSession, session.id == localSessionID else { return }
            session.serverSessionId = serverSessionID
            self?.activeSession = session
        }
        engine.onAbsoluteAltitudeSupported = { [weak self] localSessionID in
            self?.core.enableAbsoluteAltitudeUpload(sessionID: localSessionID)
        }
        uploadEngine = engine
        if let id = activeSession?.id { engine.activate(sessionID: id) }
    }

    private func updatePendingCount(_ count: Int) {
        pendingUploadCount = count
        guard activeSession != nil, count > uploadPeak else { return }
        uploadPeak = count
        core.updateHostDiagnostics { $0.pendingUploadPeakCount = max($0.pendingUploadPeakCount, count) }
    }

    /// Called whenever the authenticated collector or configured server changes (login, logout,
    /// server address edit). Gates every queued upload — including leftovers from a previous
    /// run — to the collector+server currently signed in.
    func updateUploadOwner(collectorId: String?, serverKey: String?) {
        guard let collectorId, let serverKey else {
            uploadEngine?.updateOwner(nil)
            return
        }
        uploadEngine?.updateOwner(UploadOwner(collectorId: collectorId, serverKey: serverKey))
    }

    // MARK: Start

    func startSession(
        collectorId: String,
        serverKey: String,
        motionRate: MotionSamplingRate,
        locationProfile: LocationCollectionProfile,
        distanceFilter: Double,
        healthStride: HealthStrideService? = nil,
        arkitEnabled: Bool = false,
        arkitRate: ARKitPoseRate = .hz10,
        walkingFrameEnabled: Bool = false,
        startAnchor: CollectionAnchor? = nil
    ) {
        guard activeSession == nil, captureState == .idle else {
            print("[Start] blocked: capture state \(captureState.rawValue)")
            return
        }
        guard interruptedCollection == nil else {
            captureStorageError = "START_BLOCKED_INTERRUPTED_SESSION: resume or finish the interrupted session first"
            return
        }
        let clocks: SensorRunClocks
        do {
            clocks = try prepareSensorRunClocks()
        } catch {
            captureStorageError = "CLOCK_ANCHOR_INITIALIZATION_FAILED: \(String(reflecting: error))"
            print("[Diagnostics] CLOCK_ANCHOR_INITIALIZATION_FAILED error=\(String(reflecting: error))")
            return
        }
        captureStorageError = nil
        let attitudeFrame = MotionService.preferredAttitudeReferenceFrame()
        var walkingConfiguration = WalkingFrameEstimatorConfiguration()
        walkingConfiguration.nominalSamplingHz = motionRate.rawValue
        var detected = capabilityDetector()
        detected.attitudeReferenceFrame = MotionService.label(for: attitudeFrame)
        detected.motionUpdateHz = motionRate.rawValue
        detected.locationAuthorization = locationService.authorizationStatus.diagnosticLabel
        detected.locationAccuracyAuthorization = locationService.accuracyAuthorization.diagnosticLabel
        detected.backgroundLocationUpdates = true
        detected.pausesLocationUpdatesAutomatically = false
        // Always BestForNavigation / no filter during collection (see `LocationService.start`),
        // independent of whatever `locationProfile`/`distanceFilter` were requested below.
        detected.locationDesiredAccuracy = "kCLLocationAccuracyBestForNavigation"
        detected.locationDistanceFilterMeters = 0
        detected.locationActivityType = "fitness"
        detected.locationRequestedProfile = locationProfile.rawValue
        detected.arkitEnabled = arkitEnabled && arkitSupported
        detected.walkingFrameEnabled = walkingFrameEnabled
        detected.walkingFrameAlgorithmVersion = walkingFrameEnabled ? WalkingFrameEstimatorConfiguration.algorithmVersion : nil
        detected.walkingFrameSchemaVersion = walkingFrameEnabled ? WalkingFrameSnapshot.schemaVersion : nil
        detected.walkingFrameWindowSeconds = walkingFrameEnabled ? walkingConfiguration.windowDuration : nil
        detected.walkingFrameUpdateIntervalSeconds = walkingFrameEnabled ? walkingConfiguration.updateInterval : nil
        capabilities = detected
        let device = DeviceInfoProvider.current(capabilities: detected)
        // Fixed once, here, from whatever was ready in-memory at this instant.
        let startedAt = Date()
        let strideCalibration = healthStride?.readyCandidateForNewSession(sessionStartedAt: startedAt)
        let session = CollectionSession(
            id: UUID(), collectorId: collectorId.isEmpty ? "Unassigned" : collectorId, deviceId: device.deviceId,
            startedAt: startedAt, endedAt: nil, status: .recording, serverSessionId: nil,
            deviceModel: device.deviceModel, systemVersion: device.systemVersion, sensorCapabilities: detected,
            sampleCounts: SampleCounts(), strideCalibration: strideCalibration)
        let snapshot = ActiveCollectionState(
            session: session, motionRate: motionRate, locationProfile: locationProfile, distanceFilter: distanceFilter,
            locationSequence: 0, motionSequence: 0, altimeterSequence: 0, pedometerSequence: 0,
            lastPersistedAt: startedAt, lastLocationTimestamp: nil, lastMotionTimestamp: nil,
            lastAltimeterTimestamp: nil, lastPedometerTimestamp: nil,
            diagnostics: CollectionDiagnostics(lowPowerModeObserved: ProcessInfo.processInfo.isLowPowerModeEnabled,
                                               thermalStatePeak: ProcessInfo.processInfo.thermalState.rawValue))
        let startPayload = SessionStartPayload(
            clientSessionId: session.id.uuidString, deviceId: device.deviceId.uuidString, deviceModel: device.deviceModel,
            systemVersion: device.systemVersion, appVersion: device.appVersion, sensorCapabilities: detected,
            startedAt: startedAt, strideCalibration: strideCalibration)
        let payloadData: Data
        do { payloadData = try TrackingJSONCodec.makeEncoder().encode(startPayload) }
        catch {
            captureStorageError = "SESSION_START_ENCODING_FAILED: \(error)"
            return
        }
        arkitEnabledSetting = arkitEnabled && arkitSupported
        arkitRateSetting = arkitRate
        let streams = Self.streams(for: detected, arkit: arkitEnabledSetting)
        let request = SessionBeginRequest(
            snapshot: snapshot, owner: UploadOwner(collectorId: session.collectorId, serverKey: serverKey),
            startPayload: payloadData, clocks: clocks, streams: streams,
            walkingFrame: walkingFrameEnabled ? walkingConfiguration : nil, deviceID: device.deviceId)
        captureState = .starting
        resetRunUI()
        print("[Start] persisting session id=\(session.id.uuidString)")
        core.beginSession(request) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(info):
                self.didOpenRun(info, attitudeFrame: attitudeFrame, recoverPedometer: false)
                print("[Diagnostics] SESSION_STARTED session=\(info.snapshot.session.id.uuidString)")
                // the place picked before Start, at the moment Start was pressed
                if let startAnchor { self.addMarker(type: .sessionStart, anchor: startAnchor, at: startedAt) }
            case let .failure(error):
                // Same session is never re-created under a new UUID automatically.
                self.captureState = .idle
                self.captureStorageError = "SESSION_START_PERSISTENCE_FAILED: \(error)"
            }
        }
    }

    private static func streams(for capabilities: SensorCapabilities, arkit: Bool) -> Set<CaptureStream> {
        var streams: Set<CaptureStream> = []
        if capabilities.locationAvailable { streams.insert(.location) }
        if capabilities.deviceMotionAvailable { streams.insert(.motion) }
        if capabilities.altimeterAvailable { streams.insert(.altimeter) }
        if capabilities.absoluteAltitudeEnabled == true { streams.insert(.absoluteAltitude) }
        if capabilities.pedometerAvailable { streams.insert(.pedometer) }
        if arkit { streams.insert(.arkit) }
        return streams
    }

    private func resetRunUI() {
        uiCounts = SampleCounts()
        durableCounts = SampleCounts()
        latestLocation = nil
        latestRelativeAltitude = nil
        latestStepCount = nil
        lastPlace = nil
        openVertical = nil
        openVerticalAnchor = nil
        verticalReference = nil
        walkingFrameSnapshot = nil
        magneticCalibrationQuality = .unavailable
        arkitTrackingState = .notAvailable
        arkitTrackingStateReason = nil
        arkitSessionId = nil
        arkitPoseCount = 0
        arkitLastPoseAt = nil
        arkitError = nil
        arkitBackpressurePaused = false
        uploadPeak = 0
    }

    private func didOpenRun(_ info: CaptureRunInfo, attitudeFrame: CMAttitudeReferenceFrame, recoverPedometer: Bool) {
        let snapshot = info.snapshot
        activeSession = snapshot.session
        runtimeState = snapshot
        diagnostics = snapshot.diagnostics
        capabilities = snapshot.session.sensorCapabilities
        uiCounts = snapshot.session.sampleCounts
        durableCounts = snapshot.session.sampleCounts
        contexts = info.contexts
        captureState = .recording
        interruptedCollection = nil
        if let engine = uploadEngine {
            let id = snapshot.session.id
            engine.registerSession(id: id) { [weak engine] in engine?.activate(sessionID: id) }
            engine.ingest(info.committedItems)
        }
        startSensors(sessionStart: snapshot.session.startedAt, motionRate: snapshot.motionRate, attitudeFrame: attitudeFrame,
                     locationProfile: snapshot.locationProfile, distanceFilter: snapshot.distanceFilter)
        if recoverPedometer { recoverPedometerIfNeeded(since: snapshot.lastPedometerTimestamp) }
        UIApplication.shared.isIdleTimerDisabled = true
    }

    // MARK: Stop

    /// `endAnchor`: where the collector stands at the end; recorded before the stop so the
    /// sessionEnd marker is committed ahead of the finish item.
    func stopSession(endAnchor: CollectionAnchor? = nil) {
        guard let session = activeSession else { return }
        if captureState == .recording, let endAnchor { addMarker(type: .sessionEnd, anchor: endAnchor) }
        switch captureState {
        case .stopping, .starting, .idle:
            return
        case .storageFailure:
            // Retry the same Stop: same session, fixed endedAt and already-issued sequences.
            captureState = .stopping
            core.beginStop(reason: "user_stop") { [weak self] result in self?.handleStopResult(result) }
        case .recording:
            captureState = .stopping
            UIApplication.shared.isIdleTimerDisabled = false
            // Logged first so these diagnostics precede the finish item in the ledger.
            logSensorStops(sessionID: session.id, reason: "user_stop")
            // Admission boundary first (ingress close + drain barrier), then stop hardware.
            core.beginStop(reason: "user_stop") { [weak self] result in self?.handleStopResult(result) }
            stopSensors()
            print("[Diagnostics] SESSION_STOP_REQUESTED session=\(session.id.uuidString)")
        }
    }

    private func handleStopResult(_ result: Result<StopResult, Error>) {
        switch result {
        case let .success(stop):
            uploadEngine?.ingest(stop.items)
            uploadEngine?.deactivate(sessionID: stop.sessionID)
            durableCounts = stop.snapshot.session.sampleCounts
            uiCounts = stop.snapshot.session.sampleCounts
            activeSession = nil
            runtimeState = nil
            diagnostics = nil
            contexts = [:]
            captureState = .idle
            captureStorageError = nil
            print("[Diagnostics] SESSION_FINISHED session=\(stop.sessionID.uuidString) lastSequences location=\(stop.manifest.location) motion=\(stop.manifest.motion) altimeter=\(stop.manifest.altimeter) pedometer=\(stop.manifest.pedometer)")
        case let .failure(error):
            // Stop intent, buffer and recovery info are kept; pressing Stop again retries.
            captureState = .storageFailure
            captureStorageError = String(describing: error)
            print("[Diagnostics] STOP_FINALIZATION_FAILED error=\(error)")
        }
    }

    private func logSensorStops(sessionID: UUID, reason: String) {
        for stream in contexts.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
            var metadata = ["sensor": stream.rawValue, "reason": reason]
            if let context = contexts[stream] { metadata["sensorSegmentId"] = context.streamSegmentID.uuidString }
            if stream == .arkit { metadata["arSessionId"] = arkitTrackingService.arSessionId.uuidString }
            logDiagnosticEvent("SENSOR_STOPPED", metadata: metadata, sessionID: sessionID)
        }
    }

    private func stopSensors() {
        locationService.stop()
        motionService.stop()
        altimeterService.stop()
        absoluteAltitudeService.stop()
        pedometerService.stop()
        arkitTrackingService.stop()
        arkitEnabledSetting = false
    }

    // MARK: Interrupted sessions

    /// ARKit never resumes across an app relaunch: this always starts ARKit fresh with a new
    /// `arSessionId`. The session id, owner and durable sequence boundaries are kept; every stream
    /// gets a new segment/generation and the clocks are re-anchored for the new run.
    func resumeInterruptedCollection(serverKey: String, arkitEnabled: Bool = false, arkitRate: ARKitPoseRate = .hz10) {
        guard let recovered = interruptedCollection, activeSession == nil, captureState == .idle else { return }
        guard recovered.pendingStop == nil else {
            captureStorageError = "RESUME_BLOCKED_PENDING_FINALIZATION"
            return
        }
        let clocks: SensorRunClocks
        do {
            clocks = try prepareSensorRunClocks()
        } catch {
            captureStorageError = "CLOCK_ANCHOR_INITIALIZATION_FAILED: \(String(reflecting: error))"
            print("[Diagnostics] CLOCK_ANCHOR_INITIALIZATION_FAILED phase=resume error=\(String(reflecting: error))")
            return
        }
        arkitEnabledSetting = arkitEnabled && arkitSupported
        arkitRateSetting = arkitRate
        var walking: WalkingFrameEstimatorConfiguration?
        if recovered.session.sensorCapabilities.walkingFrameEnabled == true {
            var configuration = WalkingFrameEstimatorConfiguration()
            configuration.nominalSamplingHz = recovered.motionRate.rawValue
            walking = configuration
        }
        let device = DeviceInfoProvider.current(capabilities: recovered.session.sensorCapabilities)
        let request = SessionResumeRequest(sessionID: recovered.session.id, clocks: clocks,
            streams: Self.streams(for: recovered.session.sensorCapabilities, arkit: arkitEnabledSetting),
            walkingFrame: walking, deviceID: device.deviceId)
        captureState = .starting
        resetRunUI()
        core.resumeSession(request) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(info):
                self.captureStorageError = nil
                self.didOpenRun(info, attitudeFrame: MotionService.preferredAttitudeReferenceFrame(), recoverPedometer: true)
                print("[Diagnostics] SESSION_RESUMED_WITH_GAP session=\(info.snapshot.session.id.uuidString)")
            case let .failure(error):
                self.captureState = .idle
                self.captureStorageError = "RESUME_FAILED: \(error)"
            }
        }
    }

    /// Closes the interrupted session locally AND tells the server. `endedAt` is the last moment
    /// this device is known to have recorded (or the persisted Stop cutoff), not "now".
    func finishInterruptedCollection(serverKey: String) {
        guard let recovered = interruptedCollection, activeSession == nil, captureState == .idle else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        captureState = .stopping
        core.finishRecovered(sessionID: recovered.session.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(stop):
                if let engine = self.uploadEngine {
                    engine.registerSession(id: stop.sessionID) { [weak engine] in engine?.ingest(stop.items) }
                }
                self.interruptedCollection = nil
                self.captureState = .idle
                self.captureStorageError = nil
            case let .failure(error):
                self.captureState = .idle
                self.captureStorageError = "INTERRUPTED_FINISH_FAILED: \(error)"
            }
        }
    }

    // MARK: Markers, app state, history

    func addMarker(type: EventMarkerType, note: String? = nil, anchor: CollectionAnchor? = nil, at timestamp: Date = Date()) {
        guard let session = activeSession, captureState == .recording else { return }
        let location = locationService.lastLocation
        core.addMarker(EventMarker(
            id: UUID(), sessionId: session.id, timestamp: timestamp, type: type, note: note,
            latitude: location?.coordinate.latitude, longitude: location?.coordinate.longitude,
            altitude: location?.altitude, horizontalAccuracy: location?.horizontalAccuracy,
            verticalAccuracy: location?.verticalAccuracy, anchor: anchor))
        noteAnchor(type: type, anchor: anchor)
    }

    /// Keeps the current place for the pickers and the barometric reference for the reminder.
    private func noteAnchor(type: EventMarkerType, anchor: CollectionAnchor?) {
        switch type {
        case .stairStart, .elevatorBoard, .rampStart:
            openVertical = type
            openVerticalAnchor = anchor
        case .stairEnd, .elevatorExit, .rampEnd:
            openVertical = nil
            openVerticalAnchor = nil
            verticalReference = latestRelativeAltitude
            if let floor = anchor?.toFloor, var place = lastPlace {
                place.floor = floor; place.nodeId = nil; place.nodeLabel = nil
                lastPlace = place
            }
        case .sessionStart, .entrance:
            verticalReference = latestRelativeAltitude
        default:
            break
        }
        if let building = anchor?.buildingId { lastPlace = CollectionAnchor(buildingId: building, floor: anchor?.floor) }
    }

    func requestAlwaysLocationAuthorization() {
        locationService.requestAlwaysAuthorization()
    }

    /// Call as early as possible (app launch), not from the Start button: the system permission
    /// prompt must be settled before a session can start, never appear mid-start.
    func requestLocationAuthorizationIfNeeded() {
        locationService.requestWhenInUseAuthorizationIfNeeded()
    }

    func handleAppState(_ state: CollectorAppState) {
        let now = Date()
        let elapsed = now.timeIntervalSince(appStateChangedAt)
        let previous = appState
        appStateBox.set(state)
        if activeSession != nil, captureState == .recording {
            let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            let thermal = ProcessInfo.processInfo.thermalState.rawValue
            core.updateHostDiagnostics { diagnostics in
                switch previous {
                case .background: diagnostics.backgroundDuration += elapsed
                case .foreground: diagnostics.foregroundDuration += elapsed
                case .inactive: break
                }
                if state == .background, previous != .background { diagnostics.backgroundTransitionCount += 1 }
                diagnostics.lowPowerModeObserved = diagnostics.lowPowerModeObserved || lowPower
                diagnostics.thermalStatePeak = max(diagnostics.thermalStatePeak, thermal)
            }
            if state == .background, previous != .background {
                print("[Diagnostics] APP_BACKGROUND")
                logDiagnosticEvent("APP_BACKGROUND")
                // Background may precede suspension: commit the unsaved tail now.
                core.flushNow()
            } else if state == .foreground, previous != .foreground {
                print("[Diagnostics] APP_FOREGROUND")
                logDiagnosticEvent("APP_FOREGROUND")
            }
            if state == .background, arkitTrackingService.isActive {
                arkitTrackingService.pauseForBackground()
                logDiagnosticEvent("SENSOR_PAUSED", metadata: ["sensor": "arkit", "reason": "app_background"])
            } else if state == .foreground, arkitEnabledSetting, !arkitBackpressurePaused,
                      arkitTrackingService.runState == .pausedInBackground {
                arkitTrackingService.resumeFromBackground(rate: arkitRateSetting)
                logDiagnosticEvent("SENSOR_RESUMED", metadata: ["sensor": "arkit", "arSessionId": arkitTrackingService.arSessionId.uuidString, "reason": "app_foreground"])
            }
        }
        appState = state
        appStateChangedAt = now

        if state == .foreground {
            // Settings (permission, Precise Location) can change while backgrounded.
            let newAuthorization = locationService.authorizationStatus
            let newAccuracy = locationService.accuracyAuthorization
            if activeSession != nil, newAuthorization != locationAuthorization || newAccuracy != accuracyAuthorization {
                logDiagnosticEvent("LOCATION_AUTHORIZATION_CHANGED", metadata: [
                    "status": newAuthorization.diagnosticLabel,
                    "accuracyAuthorization": newAccuracy.diagnosticLabel
                ])
            }
            locationAuthorization = newAuthorization
            accuracyAuthorization = newAccuracy
        }
        // Ordinary foreground transitions do NOT need pedometer recovery: the live pedometer
        // stream keeps delivering cumulative counts from the session start.
    }

    func loadSessions(completion: @escaping ([CollectionSession]) -> Void) {
        let legacyRoot = store.legacyDirectory
        store.async({ access -> [CollectionSession] in
            let current = try access.listCollectionSessions()
            let known = Set(current.map(\.id))
            let legacy = LegacySessionArchive.listSessions(root: legacyRoot).filter { !known.contains($0.id) }
            return (current + legacy).sorted { $0.startedAt > $1.startedAt }
        }) { result in
            completion((try? result.get()) ?? [])
        }
    }

    // MARK: ARKit backpressure

    /// Manual only (never automatic). Allowed once the stored backlog is below the resume
    /// thresholds; restarts ARKit with a new arSessionId.
    func resumeArkitAfterBackpressure() {
        guard arkitBackpressurePaused, activeSession != nil, captureState == .recording else { return }
        core.reopenArkit { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(context):
                self.contexts[.arkit] = context
                self.arkitBackpressurePaused = false
                self.arkitError = nil
                self.arkitEnabledSetting = true
                self.startArkit(context: context)
                self.logDiagnosticEvent("ARKIT_BACKPRESSURE_RESUMED", metadata: ["arSessionId": self.arkitTrackingService.arSessionId.uuidString])
            case let .failure(error):
                self.arkitError = String(describing: error)
            }
        }
    }

    func arkitBacklog() -> (count: Int, oldestAgeSeconds: Double)? {
        guard let id = activeSession?.id else { return nil }
        return uploadEngine?.arkitBacklog(sessionID: id)
    }

    // MARK: Sensors

    private func startSensors(sessionStart: Date, motionRate: MotionSamplingRate, attitudeFrame: CMAttitudeReferenceFrame,
                              locationProfile: LocationCollectionProfile, distanceFilter: Double) {
        let core = self.core
        let box = appStateBox
        func started(_ stream: CaptureStream, _ ok: Bool, extra: [String: String] = [:]) {
            guard let context = contexts[stream] else { return }
            var metadata = ["sensor": stream.rawValue, "sensorSegmentId": context.streamSegmentID.uuidString]
            metadata.merge(extra) { $1 }
            logDiagnosticEvent(ok ? "SENSOR_STARTED" : "SENSOR_START_FAILED", metadata: metadata)
        }
        guard startsHardwareSensors else { return }
        if let context = contexts[.location] {
            locationService.onLocation = { location in
                core.submit(.now(.location(LocationService.capture(location)), appState: box.value), context: context)
            }
            locationService.start(profile: locationProfile, distanceFilter: distanceFilter)
            started(.location, locationService.isActive)
        }
        if let context = contexts[.motion] {
            motionService.start(rate: motionRate, using: attitudeFrame) { capture in
                core.submit(.now(.motion(capture), appState: box.value), context: context)
            }
            started(.motion, motionService.isActive, extra: ["referenceFrame": MotionService.label(for: attitudeFrame)])
        }
        if let context = contexts[.altimeter] {
            altimeterService.start { capture in
                core.submit(.now(.altimeter(capture), appState: box.value), context: context)
            }
            started(.altimeter, altimeterService.isActive)
        }
        if let context = contexts[.absoluteAltitude] {
            absoluteAltitudeService.start { capture in
                core.submit(.now(.absoluteAltitude(capture), appState: box.value), context: context)
            }
            started(.absoluteAltitude, absoluteAltitudeService.isActive)
        }
        if let context = contexts[.pedometer] {
            pedometerService.start(capabilities: capabilities, from: sessionStart, handler: { capture in
                core.submit(.now(.pedometer(capture), appState: box.value), context: context)
            }, onError: { [weak self] domain, code in
                DispatchQueue.main.async {
                    self?.logDiagnosticEvent("PEDOMETER_ERROR", metadata: ["domain": domain, "code": String(code)])
                }
            })
            started(.pedometer, pedometerService.isActive)
        }
        if let context = contexts[.arkit] {
            startArkit(context: context)
        }
    }

    private func startArkit(context: TrackingCaptureContext) {
        let core = self.core
        let box = appStateBox
        guard startsHardwareSensors else { return }
        arkitTrackingService.onPose = { pose in
            core.submit(.now(.arkit(pose), appState: box.value), context: context)
        }
        arkitTrackingService.start(rate: arkitRateSetting)
        print("[Diagnostics] ARKIT_STARTED arSessionId=\(arkitTrackingService.arSessionId.uuidString) rate=\(arkitRateSetting.rawValue)Hz")
        logDiagnosticEvent(arkitTrackingService.isActive ? "SENSOR_STARTED" : "SENSOR_START_FAILED",
                           metadata: ["sensor": "arkit", "arSessionId": arkitTrackingService.arSessionId.uuidString])
    }

    /// Only reached from `resumeInterruptedCollection()` (a genuine relaunch recovery). Queries
    /// from the session start so the recovered sample is cumulative; the core drops it if a live
    /// sample with the same millisecond endDate already exists.
    private func recoverPedometerIfNeeded(since timestamp: Date?) {
        guard startsHardwareSensors, let timestamp, let session = activeSession, timestamp < Date(),
              let context = contexts[.pedometer] else { return }
        let core = self.core
        let box = appStateBox
        pedometerService.recover(from: session.startedAt, capabilities: capabilities) { capture in
            guard let capture, capture.endDate > timestamp else { return }
            print("[Diagnostics] PEDOMETER_HISTORICAL_RECOVERY to=\(capture.endDate)")
            core.submit(.now(.pedometer(capture), appState: box.value), context: context)
        }
    }

    private func configureCallbacks() {
        locationService.onAuthorizationChanged = { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                self.locationAuthorization = status
                let accuracy = self.locationService.accuracyAuthorization
                self.accuracyAuthorization = accuracy
                self.logDiagnosticEvent("LOCATION_AUTHORIZATION_CHANGED", metadata: [
                    "status": status.diagnosticLabel,
                    "accuracyAuthorization": accuracy.diagnosticLabel
                ])
            }
        }
        locationService.onError = { [weak self] error in
            let nsError = error as NSError
            DispatchQueue.main.async {
                self?.logDiagnosticEvent("LOCATION_ERROR", metadata: ["domain": nsError.domain, "code": String(nsError.code)])
            }
        }
        locationService.onPaused = { [weak self] in
            DispatchQueue.main.async { self?.logDiagnosticEvent("LOCATION_PAUSED") }
        }
        locationService.onResumed = { [weak self] in
            DispatchQueue.main.async { self?.logDiagnosticEvent("LOCATION_RESUMED") }
        }
        arkitTrackingService.onTrackingStateChanged = { [weak self] state, reason in
            DispatchQueue.main.async {
                self?.arkitTrackingState = state
                self?.arkitTrackingStateReason = reason
                self?.logDiagnosticEvent("ARKIT_TRACKING_STATE_CHANGED", metadata: [
                    "trackingState": state.rawValue,
                    "reason": reason?.rawValue ?? "none"
                ])
            }
        }
        arkitTrackingService.onSessionReset = { [weak self] newArSessionId in
            DispatchQueue.main.async {
                self?.arkitSessionId = newArSessionId
                self?.logDiagnosticEvent("ARKIT_SESSION_RESET", metadata: ["arSessionId": newArSessionId.uuidString])
            }
        }
        arkitTrackingService.onError = { [weak self] message in
            DispatchQueue.main.async {
                self?.arkitError = message
                self?.logDiagnosticEvent("ARKIT_ERROR", metadata: ["message": message])
            }
        }
        arkitTrackingService.onInterruption = { [weak self] began in
            DispatchQueue.main.async {
                self?.logDiagnosticEvent(began ? "ARKIT_INTERRUPTED" : "ARKIT_INTERRUPTION_ENDED")
            }
        }
    }

    // MARK: Core events

    private func handle(_ event: CollectionCoreEvent) {
        switch event {
        case let .snapshot(snapshot):
            guard snapshot.sessionID == activeSession?.id else { return }
            uiCounts = snapshot.acceptedCounts
            durableCounts = snapshot.durableCounts
            latestLocation = snapshot.latestLocation ?? latestLocation
            latestRelativeAltitude = snapshot.latestRelativeAltitude ?? latestRelativeAltitude
            if verticalReference == nil { verticalReference = latestRelativeAltitude }
            latestStepCount = snapshot.latestStepCount ?? latestStepCount
            arkitPoseCount = snapshot.arkitPoseCount
            arkitLastPoseAt = snapshot.arkitLastPoseAt
            if let frame = snapshot.walkingFrame { walkingFrameSnapshot = frame }
            if let quality = snapshot.magneticQuality { magneticCalibrationQuality = quality }
            runtimeState = snapshot.state
            diagnostics = snapshot.state.diagnostics
            lastPersistedAt = snapshot.lastCommitAt
            uploadEngine?.update(sampleCounts: snapshot.acceptedCounts)
            detectSensorCallbackStalls(now: Date())
        case let .uploadItemsCommitted(items):
            uploadEngine?.ingest(items)
        case let .storageFailure(sessionID, code, message):
            guard sessionID == activeSession?.id else { return }
            if captureState == .recording {
                stopSensors()
                UIApplication.shared.isIdleTimerDisabled = false
            }
            if captureState != .stopping { captureState = .storageFailure }
            captureStorageError = "\(code): \(message)"
        case let .diagnostic(sessionID, type, metadata):
            logDiagnosticEvent(type, metadata: metadata, sessionID: sessionID)
        case let .arkitBackpressurePaused(sessionID, backlog, age):
            guard sessionID == activeSession?.id else { return }
            arkitTrackingService.stop()
            arkitBackpressurePaused = true
            logDiagnosticEvent("ARKIT_BACKPRESSURE_PAUSED", metadata: [
                "pendingPoses": String(backlog), "oldestAgeSeconds": String(format: "%.1f", age)], sessionID: sessionID)
        }
    }

    private func logDiagnosticEvent(_ type: String, metadata: [String: String] = [:], sessionID: UUID? = nil) {
        guard let id = sessionID ?? activeSession?.id else { return }
        uploadEngine?.logDiagnostic(eventType: type, metadata: metadata, clientSessionId: id.uuidString)
    }

    private func detectSensorCallbackStalls(now: Date) {
        guard activeSession != nil else { return }
        if motionService.isActive, let last = runtimeState?.lastMotionTimestamp {
            if now.timeIntervalSince(last) >= 2, !motionStallReported {
                motionStallReported = true
                logDiagnosticEvent("SENSOR_CALLBACK_STALLED", metadata: [
                    "sensor": "motion", "seconds": String(format: "%.1f", now.timeIntervalSince(last)), "appState": appState.rawValue])
            } else if now.timeIntervalSince(last) < 2 {
                motionStallReported = false
            }
        }
        if altimeterService.isActive, let last = runtimeState?.lastAltimeterTimestamp {
            if now.timeIntervalSince(last) >= 5, !altimeterStallReported {
                altimeterStallReported = true
                logDiagnosticEvent("SENSOR_CALLBACK_STALLED", metadata: [
                    "sensor": "altimeter", "seconds": String(format: "%.1f", now.timeIntervalSince(last)), "appState": appState.rawValue])
            } else if now.timeIntervalSince(last) < 5 {
                altimeterStallReported = false
            }
        }
    }

    // MARK: Test seams (real ingress → core → SQLite path, no sensor hardware)

    func ingestSyntheticMotionForTesting(nativeTimestamp: TimeInterval) {
        guard let context = contexts[.motion] else { return }
        let zero = Vector3D(x: 0, y: 0, z: 0)
        core.submit(.now(.motion(MotionCapture(nativeTimestamp: nativeTimestamp, userAcceleration: zero, rotationRate: zero,
            gravity: Vector3D(x: 0, y: 0, z: -1), roll: 0, pitch: 0, yaw: 0,
            quaternion: QuaternionD(x: 0, y: 0, z: 0, w: 1), magneticField: nil)), appState: appStateBox.value),
            context: context)
    }

    func ingestSyntheticForTesting(_ payload: CapturedPayload) {
        guard let context = contexts[payload.stream] else { return }
        core.submit(.now(payload, appState: appStateBox.value), context: context)
    }

    func waitForCaptureIdleForTesting() { core.waitUntilIdleForTesting() }

    var captureContextsForTesting: [CaptureStream: TrackingCaptureContext] { contexts }

    var sensorRunClockIdentityForTesting: (Date, Date, Date)? {
        guard let clocks = lastPreparedClocks else { return nil }
        return (clocks.motion.epochAtAnchor, clocks.altimeter.epochAtAnchor, clocks.arkit.epochAtAnchor)
    }
}
