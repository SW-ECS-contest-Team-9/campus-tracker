import ARKit
import Combine
import CoreLocation
import CoreMotion
import Foundation
import UIKit

/// `CMDeviceMotion`/`CMAltitudeData` timestamps are boot-relative (`CMLogItem.timestamp`:
/// "seconds since the device booted"), converted to wall-clock via a `bootTime` offset
/// (`Date() - ProcessInfo.processInfo.systemUptime`) computed once at launch. If the clock that
/// offset is built from and the sensor's own boot-relative clock disagree about whether time
/// asleep counts (confirmed on real sessions: motion/altimeter samples landing ~40s before
/// `session.startedAt` and before location/pedometer — which use `CLLocation.timestamp`/
/// `CMPedometerData.endDate` directly, not `bootTime` — with zero delivery gaps in between, so
/// this is a constant conversion offset, not a stalled sensor), every sample converted through
/// the stale offset ends up shifted by a roughly constant amount. Calibrated once per session from
/// the first sample, the same approach as Android's `SensorTimestampCorrector`.
final class BootTimeDriftCorrector {
    private var correction: TimeInterval = 0
    private var calibrated = false

    /// Returns the corrected wall-clock date for `rawTimestamp` (a `CMLogItem.timestamp`) and,
    /// only the one time a correction is actually applied, its magnitude in milliseconds (for a
    /// `SENSOR_CLOCK_OFFSET` diagnostic) — `nil` on every other call.
    func convert(rawTimestamp: TimeInterval, bootTime: Date, now: @autoclosure () -> Date = Date()) -> (date: Date, appliedCorrectionMs: Double?) {
        let uncorrected = bootTime.addingTimeInterval(rawTimestamp)
        guard !calibrated else { return (uncorrected.addingTimeInterval(correction), nil) }
        calibrated = true
        let drift = now().timeIntervalSince(uncorrected)
        guard abs(drift) > 2 else { return (uncorrected, nil) }
        correction = drift
        return (uncorrected.addingTimeInterval(correction), drift * 1_000)
    }
}

@MainActor
final class CollectionCoordinator: NSObject, ObservableObject {
    @Published private(set) var activeSession: CollectionSession?
    @Published private(set) var capabilities = SensorCapabilityDetector.detect()
    @Published private(set) var latestLocation: LocationSample?
    @Published private(set) var latestRelativeAltitude: Double?
    @Published private(set) var latestStepCount: Int?
    @Published private(set) var uiCounts = SampleCounts()
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
    @Published private(set) var arkitBufferOverflowed = false

    private let repository: SensorDataRepository
    private let activeCollectionStore = ActiveCollectionStore()
    private let locationService = LocationService()
    private let motionService = MotionService()
    private let altimeterService = AltimeterService()
    private let pedometerService = PedometerService()
    private let arkitTrackingService = ARKitTrackingService()
    private let sequenceLeaseStore = SequenceLeaseStore()
    private let bootTime = Date().addingTimeInterval(-ProcessInfo.processInfo.systemUptime)
    private var motionTimestampCorrector = BootTimeDriftCorrector()
    private var altimeterTimestampCorrector = BootTimeDriftCorrector()
    private var locationSequence = 0
    private var motionSequence = 0
    private var altimeterSequence = 0
    private var pedometerSequence = 0
    private var locationSegmentId = ""
    private var motionSegmentId = ""
    private var altimeterSegmentId = ""
    private var pedometerSegmentId = ""
    private var refreshTimer: Timer?
    private var pendingCounts = SampleCounts()
    private var pendingLocation: LocationSample?
    private var pendingRelativeAltitude: Double?
    private var pendingStepCount: Int?
    private var telemetrySync: TelemetrySyncCoordinator?
    private var runtimeState: ActiveCollectionState?
    private var appStateChangedAt = Date()
    private var motionStallReported = false
    private var altimeterStallReported = false
    private var arkitEnabledSetting = false
    private var arkitRateSetting: ARKitPoseRate = .hz10
    private var pendingArkitPoseCount = 0
    private var pendingArkitLastPoseAt: Date?

    var isBackgroundCollectionEnabled: Bool { activeSession != nil && locationService.isActive }
    var isLocationActive: Bool { locationService.isActive }
    var isMotionActive: Bool { motionService.isActive }
    var isAltimeterActive: Bool { altimeterService.isActive }
    var isPedometerActive: Bool { pedometerService.isActive }
    var isArkitActive: Bool { arkitTrackingService.isActive }
    var lastLocationTimestamp: Date? { runtimeState?.lastLocationTimestamp }
    var lastMotionTimestamp: Date? { runtimeState?.lastMotionTimestamp }
    var lastAltimeterTimestamp: Date? { runtimeState?.lastAltimeterTimestamp }
    var lastPedometerTimestamp: Date? { runtimeState?.lastPedometerTimestamp }

    init(repository: SensorDataRepository? = nil) {
        self.repository = repository ?? LocalSensorDataRepository()
        self.locationAuthorization = locationService.authorizationStatus
        self.accuracyAuthorization = locationService.accuracyAuthorization
        super.init()
        configureCallbacks()
        if var recovered = activeCollectionStore.load() {
            recovered.diagnostics.wasInterrupted = true
            interruptedCollection = recovered
            activeCollectionStore.save(recovered, immediately: true)
            print("[Diagnostics] INTERRUPTED_COLLECTION_FOUND session=\(recovered.session.id.uuidString)")
        }
    }

    func bind(webSocket: RawWebSocketConnectionManager) {
        guard telemetrySync == nil else { return }
        let sync = TelemetrySyncCoordinator(webSocket: webSocket)
        sync.onPendingCountChanged = { [weak self] count in self?.pendingUploadCount = count }
        sync.onQuarantinedCountChanged = { [weak self] count in self?.quarantinedUploadCount = count }
        sync.onHeldCountChanged = { [weak self] count in self?.heldUploadCount = count }
        sync.onUnsynchronizedCountChanged = { [weak self] count in self?.unsynchronizedSessionCount = count }
        sync.onServerSessionStarted = { [weak self] localSessionID, serverSessionID in
            guard var session = self?.activeSession, session.id == localSessionID else { return }
            session.serverSessionId = serverSessionID
            self?.activeSession = session
            self?.repository.update(session: session)
        }
        sync.onArkitBufferOverflow = { [weak self] in self?.arkitBufferOverflowed = true }
        telemetrySync = sync
        pendingUploadCount = sync.pendingCount
        quarantinedUploadCount = sync.quarantinedCount
        heldUploadCount = sync.heldCount
        unsynchronizedSessionCount = sync.unsynchronizedCount
    }

    /// Called whenever the authenticated collector or configured server changes (login, logout,
    /// server address edit). Gates every queued upload — including leftovers from a previous
    /// run — to the collector+server currently signed in, so a login/server switch never uploads
    /// another account's or another server's unsent local data.
    func updateUploadOwner(collectorId: String?, serverKey: String?) {
        guard let collectorId, let serverKey else {
            telemetrySync?.updateOwner(nil)
            return
        }
        telemetrySync?.updateOwner(UploadOwner(collectorId: collectorId, serverKey: serverKey))
    }

    func startSession(
        collectorId: String,
        serverKey: String,
        motionRate: MotionSamplingRate,
        locationProfile: LocationCollectionProfile,
        distanceFilter: Double,
        healthStride: HealthStrideService? = nil,
        arkitEnabled: Bool = false,
        arkitRate: ARKitPoseRate = .hz10
    ) {
        guard activeSession == nil else {
            print("[Start] blocked: a local session is already active")
            return
        }
        print("[Start] CollectionCoordinator.startSession entered")
        let attitudeFrame = MotionService.preferredAttitudeReferenceFrame()
        capabilities = SensorCapabilityDetector.detect(
            attitudeReferenceFrame: MotionService.label(for: attitudeFrame),
            motionUpdateHz: motionRate.rawValue,
            locationAuthorization: locationService.authorizationStatus.diagnosticLabel,
            locationAccuracyAuthorization: locationService.accuracyAuthorization.diagnosticLabel,
            backgroundLocationUpdates: true,
            pausesLocationUpdatesAutomatically: false,
            // Always BestForNavigation / no filter during collection (see `LocationService.start`),
            // independent of whatever `locationProfile`/`distanceFilter` were requested below.
            locationDesiredAccuracy: "kCLLocationAccuracyBestForNavigation",
            locationDistanceFilterMeters: 0,
            locationActivityType: "fitness",
            locationRequestedProfile: locationProfile.rawValue,
            arkitEnabled: arkitEnabled && arkitSupported
        )
        let device = DeviceInfoProvider.current(capabilities: capabilities)
        // Fixed once, here, from whatever was ready in-memory at this instant. Never revisited
        // for this session even if a HealthKit query still in flight completes afterward.
        let startedAt = Date()
        let strideCalibration = healthStride?.readyCandidateForNewSession(sessionStartedAt: startedAt)
        let session = CollectionSession(
            id: UUID(),
            collectorId: collectorId.isEmpty ? "Unassigned" : collectorId,
            deviceId: device.deviceId,
            startedAt: startedAt,
            endedAt: nil,
            status: .recording,
            serverSessionId: nil,
            deviceModel: device.deviceModel,
            systemVersion: device.systemVersion,
            sensorCapabilities: capabilities,
            sampleCounts: SampleCounts(),
            strideCalibration: strideCalibration
        )
        activeSession = session
        uiCounts = SampleCounts()
        pendingCounts = SampleCounts()
        latestLocation = nil
        latestRelativeAltitude = nil
        latestStepCount = nil
        pendingLocation = nil
        pendingRelativeAltitude = nil
        pendingStepCount = nil
        locationSequence = 0
        motionSequence = 0
        altimeterSequence = 0
        pedometerSequence = 0
        motionTimestampCorrector = BootTimeDriftCorrector()
        altimeterTimestampCorrector = BootTimeDriftCorrector()
        arkitEnabledSetting = arkitEnabled && arkitSupported
        arkitRateSetting = arkitRate
        arkitTrackingState = .notAvailable
        arkitTrackingStateReason = nil
        arkitSessionId = nil
        arkitPoseCount = 0
        arkitLastPoseAt = nil
        arkitError = nil
        arkitBufferOverflowed = false
        pendingArkitPoseCount = 0
        pendingArkitLastPoseAt = nil
        repository.create(session: session)
        let state = ActiveCollectionState(
            session: session,
            motionRate: motionRate,
            locationProfile: locationProfile,
            distanceFilter: distanceFilter,
            locationSequence: 0,
            motionSequence: 0,
            altimeterSequence: 0,
            pedometerSequence: 0,
            lastPersistedAt: Date(),
            lastLocationTimestamp: nil,
            lastMotionTimestamp: nil,
            lastAltimeterTimestamp: nil,
            lastPedometerTimestamp: nil,
            diagnostics: CollectionDiagnostics(
                lowPowerModeObserved: ProcessInfo.processInfo.isLowPowerModeEnabled,
                thermalStatePeak: ProcessInfo.processInfo.thermalState.rawValue
            )
        )
        runtimeState = state
        interruptedCollection = nil
        persistRuntime(immediately: true)
        print("[Diagnostics] SESSION_STARTED session=\(session.id.uuidString)")
        print("[Start] local session created id=\(session.id.uuidString)")
        telemetrySync?.start(session: session, device: device, owner: UploadOwner(collectorId: session.collectorId, serverKey: serverKey))

        startSensors(
            sessionStart: session.startedAt,
            motionRate: motionRate,
            attitudeFrame: attitudeFrame,
            locationProfile: locationProfile,
            distanceFilter: distanceFilter
        )
        startUIRefreshTimer()
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func stopSession() {
        guard var session = activeSession else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        locationService.stop()
        logDiagnosticEvent("SENSOR_STOPPED", metadata: ["sensor": "location", "sensorSegmentId": locationSegmentId, "reason": "user_stop"])
        motionService.stop()
        logDiagnosticEvent("SENSOR_STOPPED", metadata: ["sensor": "motion", "sensorSegmentId": motionSegmentId, "reason": "user_stop"])
        altimeterService.stop()
        logDiagnosticEvent("SENSOR_STOPPED", metadata: ["sensor": "altimeter", "sensorSegmentId": altimeterSegmentId, "reason": "user_stop"])
        pedometerService.stop()
        logDiagnosticEvent("SENSOR_STOPPED", metadata: ["sensor": "pedometer", "sensorSegmentId": pedometerSegmentId, "reason": "user_stop"])
        if arkitTrackingService.isActive {
            logDiagnosticEvent("SENSOR_STOPPED", metadata: ["sensor": "arkit", "arSessionId": arkitTrackingService.arSessionId.uuidString, "reason": "user_stop"])
        }
        arkitTrackingService.stop()
        arkitEnabledSetting = false
        refreshTimer?.invalidate()
        refreshTimer = nil
        publishUI()
        session.status = .completed
        session.endedAt = Date()
        session.sampleCounts = pendingCounts
        telemetrySync?.finish(
            session: session,
            // Runtime state stores the last sequence actually recorded. The live counters may be
            // advanced to a durable lease boundary after crash recovery even when no new sample
            // has been emitted, so they are not a valid final manifest in that case.
            lastSequences: lastSequencesPayload(
                counts: pendingCounts,
                location: runtimeState?.locationSequence ?? locationSequence,
                motion: runtimeState?.motionSequence ?? motionSequence,
                altimeter: runtimeState?.altimeterSequence ?? altimeterSequence,
                pedometer: runtimeState?.pedometerSequence ?? pedometerSequence
            )
        )
        print("[Diagnostics] LOCATION_STOPPED")
        print("[Diagnostics] MOTION_STOPPED")
        print("[Diagnostics] ALTIMETER_STOPPED")
        print("[Diagnostics] PEDOMETER_STOPPED")
        print("[Diagnostics] ARKIT_STOPPED")
        print("[Diagnostics] SESSION_FINISHED session=\(session.id.uuidString) lastSequences location=\(locationSequence) motion=\(motionSequence) altimeter=\(altimeterSequence) pedometer=\(pedometerSequence)")
        activeSession = nil
        runtimeState = nil
        diagnostics = nil
        interruptedCollection = nil
        activeCollectionStore.clear()
        sequenceLeaseStore.clear(sessionId: session.id)
        repository.finish(session: session) { }
    }

    /// The server contract's "no samples on this stream" sentinel is `-1`, not `0` — sequences
    /// are assigned `+= 1` before use, so a stream with zero samples never issues sequence 0.
    /// Sending `0` for an empty stream previously made the server's manifest comparison treat
    /// "nothing to compare" as "expecting a sample 0 that never arrived", marking the session
    /// permanently unsynchronized even though every sample it ever produced was received.
    private func lastSequencesPayload(counts: SampleCounts, location: Int, motion: Int, altimeter: Int, pedometer: Int) -> LastSequencesPayload {
        LastSequencesPayload(
            location: counts.location == 0 ? -1 : location,
            motion: counts.motion == 0 ? -1 : motion,
            altimeter: counts.altimeter == 0 ? -1 : altimeter,
            pedometer: counts.pedometer == 0 ? -1 : pedometer
        )
    }

    func addMarker(type: EventMarkerType, note: String? = nil) {
        guard let session = activeSession else { return }
        let location = locationService.lastLocation
        let marker = EventMarker(
            id: UUID(),
            sessionId: session.id,
            timestamp: Date(),
            type: type,
            note: note,
            latitude: location?.coordinate.latitude,
            longitude: location?.coordinate.longitude,
            altitude: location?.altitude,
            horizontalAccuracy: location?.horizontalAccuracy,
            verticalAccuracy: location?.verticalAccuracy
        )
        repository.append(marker: marker)
        telemetrySync?.append(marker: marker, session: session)
        pendingCounts.marker += 1
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    func requestAlwaysLocationAuthorization() {
        locationService.requestAlwaysAuthorization()
    }

    /// Call as early as possible (app launch), not from the Start button: the system permission
    /// prompt must be settled before a session can start, never appear mid-start.
    func requestLocationAuthorizationIfNeeded() {
        locationService.requestWhenInUseAuthorizationIfNeeded()
    }

    /// ARKit never resumes across an app relaunch (no camera frames while terminated, so world
    /// tracking state can't survive it): this always starts ARKit fresh with a new `arSessionId`,
    /// same as a brand-new session, rather than trying to restore anything AR-related.
    func resumeInterruptedCollection(serverKey: String, arkitEnabled: Bool = false, arkitRate: ARKitPoseRate = .hz10) {
        guard var recovered = interruptedCollection, activeSession == nil else { return }
        recovered.diagnostics.wasInterrupted = true
        runtimeState = recovered
        capabilities = recovered.session.sensorCapabilities
        activeSession = recovered.session
        // The debounced ActiveCollectionState snapshot can lag up to ~1s behind what was actually
        // issued before a crash; the durable per-stream lease (persisted synchronously, see
        // SequenceLeaseStore) is never behind it, so it wins whenever the two disagree.
        let lease = sequenceLeaseStore.load(sessionId: recovered.session.id)
        locationSequence = max(recovered.locationSequence, lease.location)
        motionSequence = max(recovered.motionSequence, lease.motion)
        altimeterSequence = max(recovered.altimeterSequence, lease.altimeter)
        pedometerSequence = max(recovered.pedometerSequence, lease.pedometer)
        pendingCounts = recovered.session.sampleCounts
        uiCounts = pendingCounts
        interruptedCollection = nil
        arkitEnabledSetting = arkitEnabled && arkitSupported
        arkitRateSetting = arkitRate
        arkitTrackingState = .notAvailable
        arkitTrackingStateReason = nil
        arkitSessionId = nil
        arkitPoseCount = 0
        arkitLastPoseAt = nil
        arkitError = nil
        arkitBufferOverflowed = false
        pendingArkitPoseCount = 0
        pendingArkitLastPoseAt = nil

        repository.resume(session: recovered.session)
        let device = DeviceInfoProvider.current(capabilities: recovered.session.sensorCapabilities)
        telemetrySync?.start(session: recovered.session, device: device, owner: UploadOwner(collectorId: recovered.session.collectorId, serverKey: serverKey))
        let attitudeFrame = MotionService.preferredAttitudeReferenceFrame()
        startSensors(
            sessionStart: recovered.session.startedAt,
            motionRate: recovered.motionRate,
            attitudeFrame: attitudeFrame,
            locationProfile: recovered.locationProfile,
            distanceFilter: recovered.distanceFilter
        )
        recoverPedometerIfNeeded(since: recovered.lastPedometerTimestamp)
        startUIRefreshTimer()
        persistRuntime(immediately: true)
        UIApplication.shared.isIdleTimerDisabled = true
        print("[Diagnostics] SESSION_RESUMED_WITH_GAP session=\(recovered.session.id.uuidString)")
    }

    /// Closes the interrupted session locally AND tells the server — a server session left
    /// without a `session:finish` stays ACTIVE forever (confirmed: a prior session needed a
    /// manual preview-side interrupt because of exactly this). `endedAt` is the last moment this
    /// device is actually known to have been recording, not "now" (the app may have relaunched
    /// long after the process that was interrupted actually stopped producing samples).
    func finishInterruptedCollection(serverKey: String) {
        guard var recovered = interruptedCollection else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        let endedAt = [
            recovered.lastLocationTimestamp, recovered.lastMotionTimestamp,
            recovered.lastAltimeterTimestamp, recovered.lastPedometerTimestamp
        ].compactMap { $0 }.max() ?? recovered.lastPersistedAt
        recovered.session.status = .completed
        recovered.session.endedAt = endedAt
        recovered.diagnostics.wasInterrupted = true
        repository.resume(session: recovered.session)
        repository.finish(session: recovered.session) { }
        let device = DeviceInfoProvider.current(capabilities: recovered.session.sensorCapabilities)
        // `active: false`: registers this session's owner/start payload with the sync queue
        // without making it "the" active session (no batch/status timers) — this process never
        // ran it live, there's nothing to collect, only a finish to deliver.
        telemetrySync?.start(
            session: recovered.session,
            device: device,
            owner: UploadOwner(collectorId: recovered.session.collectorId, serverKey: serverKey),
            active: false
        )
        telemetrySync?.finish(
            session: recovered.session,
            lastSequences: lastSequencesPayload(
                counts: recovered.session.sampleCounts,
                location: recovered.locationSequence,
                motion: recovered.motionSequence,
                altimeter: recovered.altimeterSequence,
                pedometer: recovered.pedometerSequence
            ),
            interrupted: true
        )
        activeCollectionStore.clear()
        sequenceLeaseStore.clear(sessionId: recovered.session.id)
        interruptedCollection = nil
        print("[Diagnostics] SESSION_FINISHED_AS_INTERRUPTED session=\(recovered.session.id.uuidString)")
    }

    func handleAppState(_ state: CollectorAppState) {
        let now = Date()
        let elapsed = now.timeIntervalSince(appStateChangedAt)
        if var runtime = runtimeState {
            switch appState {
            case .background: runtime.diagnostics.backgroundDuration += elapsed
            case .foreground: runtime.diagnostics.foregroundDuration += elapsed
            case .inactive: break
            }
            if state == .background, appState != .background {
                runtime.diagnostics.backgroundTransitionCount += 1
                print("[Diagnostics] APP_BACKGROUND")
                logDiagnosticEvent("APP_BACKGROUND")
            } else if state == .foreground, appState != .foreground {
                print("[Diagnostics] APP_FOREGROUND")
                logDiagnosticEvent("APP_FOREGROUND")
            }
            if state == .background, arkitTrackingService.isActive {
                arkitTrackingService.pauseForBackground()
                logDiagnosticEvent("SENSOR_PAUSED", metadata: ["sensor": "arkit", "reason": "app_background"])
            } else if state == .foreground, arkitEnabledSetting, arkitTrackingService.runState == .pausedInBackground {
                arkitTrackingService.resumeFromBackground(rate: arkitRateSetting)
                logDiagnosticEvent("SENSOR_RESUMED", metadata: ["sensor": "arkit", "arSessionId": arkitTrackingService.arSessionId.uuidString, "reason": "app_foreground"])
            }
            runtime.diagnostics.lowPowerModeObserved = runtime.diagnostics.lowPowerModeObserved || ProcessInfo.processInfo.isLowPowerModeEnabled
            runtime.diagnostics.thermalStatePeak = max(runtime.diagnostics.thermalStatePeak, ProcessInfo.processInfo.thermalState.rawValue)
            runtimeState = runtime
            persistRuntime(immediately: state == .background)
        }
        appState = state
        appStateChangedAt = now

        if state == .foreground {
            // Settings (permission, Precise Location) can change while backgrounded; refresh on
            // return rather than waiting for the next delegate callback, and log it if a session
            // is running so a mid-session accuracy drop is explained rather than silently absorbed.
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

        // Ordinary foreground transitions (screen lock/unlock, brief app switches) do NOT need
        // pedometer recovery: `pedometerService.start(from: sessionStartDate)` keeps delivering
        // cumulative counts the whole time regardless of app state. Calling recovery here used to
        // inject an incremental (near-zero) sample into the cumulative stream on every such
        // transition, which is what produced the spurious 0-step samples right before Stop.
    }

    func loadSessions(completion: @escaping ([CollectionSession]) -> Void) {
        repository.loadSessions(completion: completion)
    }

    private func startSensors(
        sessionStart: Date,
        motionRate: MotionSamplingRate,
        attitudeFrame: CMAttitudeReferenceFrame,
        locationProfile: LocationCollectionProfile,
        distanceFilter: Double
    ) {
        if capabilities.locationAvailable {
            locationSegmentId = UUID().uuidString
            locationService.start(profile: locationProfile, distanceFilter: distanceFilter)
            print("[Diagnostics] LOCATION_STARTED segmentId=\(locationSegmentId) allowsBackgroundLocationUpdates=true pausesLocationUpdatesAutomatically=false")
            logDiagnosticEvent("SENSOR_STARTED", metadata: ["sensor": "location", "sensorSegmentId": locationSegmentId])
        }
        if capabilities.deviceMotionAvailable {
            motionSegmentId = UUID().uuidString
            motionService.start(rate: motionRate, using: attitudeFrame)
            print("[Diagnostics] MOTION_STARTED segmentId=\(motionSegmentId) referenceFrame=\(MotionService.label(for: attitudeFrame))")
            logDiagnosticEvent("SENSOR_STARTED", metadata: ["sensor": "motion", "sensorSegmentId": motionSegmentId, "referenceFrame": MotionService.label(for: attitudeFrame)])
        }
        if capabilities.altimeterAvailable {
            altimeterSegmentId = UUID().uuidString
            altimeterService.start()
            print("[Diagnostics] ALTIMETER_STARTED segmentId=\(altimeterSegmentId)")
            logDiagnosticEvent("SENSOR_STARTED", metadata: ["sensor": "altimeter", "sensorSegmentId": altimeterSegmentId])
        }
        if capabilities.pedometerAvailable {
            pedometerSegmentId = UUID().uuidString
            pedometerService.start(capabilities: capabilities, from: sessionStart)
            print("[Diagnostics] PEDOMETER_STARTED segmentId=\(pedometerSegmentId) from=\(sessionStart)")
            logDiagnosticEvent("SENSOR_STARTED", metadata: ["sensor": "pedometer", "sensorSegmentId": pedometerSegmentId])
        }
        if arkitEnabledSetting {
            arkitTrackingService.start(rate: arkitRateSetting)
            print("[Diagnostics] ARKIT_STARTED arSessionId=\(arkitTrackingService.arSessionId.uuidString) rate=\(arkitRateSetting.rawValue)Hz")
            logDiagnosticEvent("SENSOR_STARTED", metadata: ["sensor": "arkit", "arSessionId": arkitTrackingService.arSessionId.uuidString])
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
        locationService.onLocation = { [weak self] location in
            DispatchQueue.main.async { self?.record(location: location) }
        }
        locationService.onPaused = { [weak self] in
            DispatchQueue.main.async { self?.logDiagnosticEvent("LOCATION_PAUSED") }
        }
        locationService.onResumed = { [weak self] in
            DispatchQueue.main.async { self?.logDiagnosticEvent("LOCATION_RESUMED") }
        }
        motionService.onMotion = { [weak self] motion in
            DispatchQueue.main.async { self?.record(motion: motion) }
        }
        altimeterService.onAltitude = { [weak self] altitude in
            DispatchQueue.main.async { self?.record(altitude: altitude) }
        }
        pedometerService.onPedometer = { [weak self] data in
            DispatchQueue.main.async { self?.record(pedometer: data) }
        }
        pedometerService.onError = { [weak self] error in
            DispatchQueue.main.async {
                let nsError = error as NSError?
                self?.logDiagnosticEvent("PEDOMETER_ERROR", metadata: [
                    "domain": nsError?.domain ?? "unknown",
                    "code": nsError.map { String($0.code) } ?? "unknown"
                ])
            }
        }
        arkitTrackingService.onPose = { [weak self] pose in
            DispatchQueue.main.async { self?.record(arkitPose: pose) }
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

    private func record(location: CLLocation) {
        guard let session = activeSession else { return }
        locationSequence += 1
        sequenceLeaseStore.ensureLeased(sessionId: session.id, stream: \.location, nextSequence: locationSequence)
        let ellipsoidalAltitude: Double?
        if #available(iOS 15.0, *) {
            ellipsoidalAltitude = location.ellipsoidalAltitude
        } else {
            ellipsoidalAltitude = nil
        }
        let sample = LocationSample(id: UUID(), sessionId: session.id, sequence: locationSequence, timestamp: location.timestamp, latitude: location.coordinate.latitude, longitude: location.coordinate.longitude, altitude: location.altitude, ellipsoidalAltitude: ellipsoidalAltitude, horizontalAccuracy: location.horizontalAccuracy, verticalAccuracy: location.verticalAccuracy, speed: location.speed, course: location.course, speedAccuracy: location.speedAccuracy, courseAccuracy: location.courseAccuracy, floor: location.floor?.level, appState: appState, sensorSegmentId: locationSegmentId)
        updateRuntimeForLocation(timestamp: sample.timestamp)
        repository.append(location: sample)
        telemetrySync?.append(location: sample, session: session)
        pendingLocation = sample
        pendingCounts.location += 1
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    private func record(motion: CMDeviceMotion) {
        guard let session = activeSession else { return }
        motionSequence += 1
        sequenceLeaseStore.ensureLeased(sessionId: session.id, stream: \.motion, nextSequence: motionSequence)
        let (measuredAt, correctionMs) = motionTimestampCorrector.convert(rawTimestamp: motion.timestamp, bootTime: bootTime)
        if let correctionMs {
            logDiagnosticEvent("SENSOR_CLOCK_OFFSET", metadata: ["sensor": "motion", "offsetMs": String(Int(correctionMs))])
        }
        let sample = MotionSample(id: UUID(), sessionId: session.id, sequence: motionSequence, timestamp: measuredAt, userAccelerationX: motion.userAcceleration.x, userAccelerationY: motion.userAcceleration.y, userAccelerationZ: motion.userAcceleration.z, rotationRateX: motion.rotationRate.x, rotationRateY: motion.rotationRate.y, rotationRateZ: motion.rotationRate.z, gravityX: motion.gravity.x, gravityY: motion.gravity.y, gravityZ: motion.gravity.z, attitudeRoll: motion.attitude.roll, attitudePitch: motion.attitude.pitch, attitudeYaw: motion.attitude.yaw, appState: appState, sensorSegmentId: motionSegmentId)
        updateRuntimeForMotion(timestamp: sample.timestamp)
        repository.append(motion: sample)
        telemetrySync?.append(motion: sample, session: session)
        pendingCounts.motion += 1
        motionStallReported = false
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    private func record(altitude: CMAltitudeData) {
        guard let session = activeSession else { return }
        altimeterSequence += 1
        sequenceLeaseStore.ensureLeased(sessionId: session.id, stream: \.altimeter, nextSequence: altimeterSequence)
        let (measuredAt, correctionMs) = altimeterTimestampCorrector.convert(rawTimestamp: altitude.timestamp, bootTime: bootTime)
        if let correctionMs {
            logDiagnosticEvent("SENSOR_CLOCK_OFFSET", metadata: ["sensor": "altimeter", "offsetMs": String(Int(correctionMs))])
        }
        let sample = AltimeterSample(id: UUID(), sessionId: session.id, sequence: altimeterSequence, timestamp: measuredAt, relativeAltitude: altitude.relativeAltitude.doubleValue, pressure: altitude.pressure.doubleValue, appState: appState, sensorSegmentId: altimeterSegmentId)
        updateRuntimeForAltimeter(timestamp: sample.timestamp)
        repository.append(altimeter: sample)
        telemetrySync?.append(altimeter: sample, session: session)
        pendingRelativeAltitude = sample.relativeAltitude
        pendingCounts.altimeter += 1
        altimeterStallReported = false
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    private func record(pedometer data: CMPedometerData, source: SensorCaptureSource = .live) {
        guard let session = activeSession else { return }
        pedometerSequence += 1
        sequenceLeaseStore.ensureLeased(sessionId: session.id, stream: \.pedometer, nextSequence: pedometerSequence)
        let sample = PedometerSample(id: UUID(), sessionId: session.id, sequence: pedometerSequence, timestamp: data.endDate, captureSource: source, numberOfSteps: capabilities.stepCountingAvailable ? data.numberOfSteps.intValue : nil, distance: capabilities.distanceAvailable ? data.distance?.doubleValue : nil, currentPace: capabilities.paceAvailable ? data.currentPace?.doubleValue : nil, currentCadence: capabilities.cadenceAvailable ? data.currentCadence?.doubleValue : nil, floorsAscended: capabilities.floorCountingAvailable ? data.floorsAscended?.intValue : nil, floorsDescended: capabilities.floorCountingAvailable ? data.floorsDescended?.intValue : nil, appState: appState, sensorSegmentId: pedometerSegmentId)
        updateRuntimeForPedometer(timestamp: sample.timestamp)
        repository.append(pedometer: sample)
        telemetrySync?.append(pedometer: sample, session: session)
        pendingStepCount = sample.numberOfSteps
        pendingCounts.pedometer += 1
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    /// `pose.frameTimestamp` shares CoreMotion's boot-relative clock (see `record(motion:)`
    /// above), so it's converted through the same fixed `bootTime` offset rather than being
    /// treated as a wall-clock or send-time value.
    private func record(arkitPose pose: ARKitPoseSample) {
        guard let session = activeSession else { return }
        let measuredAt = bootTime.addingTimeInterval(pose.frameTimestamp)
        telemetrySync?.append(arkitPose: pose, measuredAt: measuredAt, session: session)
        pendingArkitPoseCount += 1
        pendingArkitLastPoseAt = measuredAt
    }

    private func updateRuntimeForLocation(timestamp: Date) {
        guard var runtime = runtimeState else { return }
        runtime.diagnostics.locationGaps.record(
            previous: runtime.lastLocationTimestamp,
            current: timestamp,
            expectedInterval: 1
        )
        runtime.lastLocationTimestamp = timestamp
        runtime.locationSequence = locationSequence
        runtimeState = runtime
        persistRuntimeIfNeeded()
    }

    private func updateRuntimeForMotion(timestamp: Date) {
        guard var runtime = runtimeState else { return }
        runtime.diagnostics.motionGaps.record(
            previous: runtime.lastMotionTimestamp,
            current: timestamp,
            expectedInterval: runtime.motionRate.interval
        )
        runtime.lastMotionTimestamp = timestamp
        runtime.motionSequence = motionSequence
        runtimeState = runtime
        persistRuntimeIfNeeded()
    }

    private func updateRuntimeForAltimeter(timestamp: Date) {
        guard var runtime = runtimeState else { return }
        runtime.diagnostics.altimeterGaps.record(
            previous: runtime.lastAltimeterTimestamp,
            current: timestamp,
            expectedInterval: 1
        )
        runtime.lastAltimeterTimestamp = timestamp
        runtime.altimeterSequence = altimeterSequence
        runtimeState = runtime
        persistRuntimeIfNeeded()
    }

    private func updateRuntimeForPedometer(timestamp: Date) {
        guard var runtime = runtimeState else { return }
        runtime.diagnostics.pedometerGaps.record(
            previous: runtime.lastPedometerTimestamp,
            current: timestamp,
            expectedInterval: 5
        )
        runtime.lastPedometerTimestamp = timestamp
        runtime.pedometerSequence = pedometerSequence
        runtimeState = runtime
        persistRuntimeIfNeeded()
    }

    private func persistRuntimeIfNeeded() {
        guard let runtime = runtimeState,
              Date().timeIntervalSince(runtime.lastPersistedAt) >= 1 else { return }
        persistRuntime()
    }

    private func persistRuntime(immediately: Bool = false) {
        guard var runtime = runtimeState else { return }
        runtime.session.sampleCounts = pendingCounts
        runtime.lastPersistedAt = Date()
        runtime.diagnostics.pendingUploadPeakCount = max(runtime.diagnostics.pendingUploadPeakCount, pendingUploadCount)
        runtimeState = runtime
        diagnostics = runtime.diagnostics
        lastPersistedAt = runtime.lastPersistedAt
        activeCollectionStore.save(runtime, immediately: immediately)
    }

    /// Only reached from `resumeInterruptedCollection()` (a genuine app-relaunch recovery), not
    /// from ordinary foreground transitions. Queries from the session start date so the single
    /// recovered sample is a cumulative value consistent with the live stream, never an
    /// incremental delta since the last sample.
    private func recoverPedometerIfNeeded(since timestamp: Date?) {
        guard let timestamp, let session = activeSession, timestamp < Date() else { return }
        let sessionStart = session.startedAt
        pedometerService.recover(from: sessionStart) { [weak self] data in
            guard let data else { return }
            DispatchQueue.main.async {
                guard let self,
                      let latest = self.runtimeState?.lastPedometerTimestamp,
                      data.endDate > latest else { return }
                print("[Diagnostics] PEDOMETER_HISTORICAL_RECOVERY from=\(sessionStart) to=\(data.endDate)")
                self.record(pedometer: data, source: .historicalRecovery)
            }
        }
    }

    private func logDiagnosticEvent(_ type: String, metadata: [String: String] = [:]) {
        guard let sessionId = activeSession?.id.uuidString else { return }
        telemetrySync?.logDiagnostic(eventType: type, metadata: metadata, clientSessionId: sessionId)
    }

    private func startUIRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(
            timeInterval: 0.5,
            target: self,
            selector: #selector(publishUI),
            userInfo: nil,
            repeats: true
        )
    }

    @objc private func publishUI() {
        uiCounts = pendingCounts
        latestLocation = pendingLocation
        latestRelativeAltitude = pendingRelativeAltitude
        latestStepCount = pendingStepCount
        arkitPoseCount = pendingArkitPoseCount
        arkitLastPoseAt = pendingArkitLastPoseAt
        detectSensorCallbackStalls(now: Date())
    }

    private func detectSensorCallbackStalls(now: Date) {
        guard activeSession != nil else { return }
        if motionService.isActive,
           let last = runtimeState?.lastMotionTimestamp,
           now.timeIntervalSince(last) >= 2,
           !motionStallReported {
            motionStallReported = true
            logDiagnosticEvent("SENSOR_CALLBACK_STALLED", metadata: [
                "sensor": "motion", "seconds": String(format: "%.1f", now.timeIntervalSince(last)),
                "appState": appState.rawValue
            ])
        }
        if altimeterService.isActive,
           let last = runtimeState?.lastAltimeterTimestamp,
           now.timeIntervalSince(last) >= 5,
           !altimeterStallReported {
            altimeterStallReported = true
            logDiagnosticEvent("SENSOR_CALLBACK_STALLED", metadata: [
                "sensor": "altimeter", "seconds": String(format: "%.1f", now.timeIntervalSince(last)),
                "appState": appState.rawValue
            ])
        }
    }
}

// MARK: - Raw WebSocket synchronization

nonisolated private struct WebSocketRequest<Payload: Encodable>: Encodable {
    let requestId: String
    let type: String
    let payload: Payload
}

nonisolated private extension Double {
    /// JSONEncoder rejects NaN and infinity. Raw local samples remain untouched; only network DTOs are normalized.
    var finiteOrNil: Double? { isFinite ? self : nil }
}

private struct WebSocketAck: Decodable {
    let requestId: String
    let ok: Bool
}

nonisolated private struct SessionStartPayload: Codable {
    let clientSessionId: String
    let deviceId: String
    let platform = "ios"
    let deviceModel: String
    let systemVersion: String
    let appVersion: String
    let sensorCapabilities: SensorCapabilities
    let startedAt: Date
    // Top-level per the server contract (docs/HEALTH_STRIDE_SERVER_PLAN.md), not nested under
    // sensorCapabilities. Omitted (nil) when no fresh candidate was ready at session start.
    let strideCalibration: StrideCalibration?
}

private struct SessionStartResponse: Decodable {
    let sessionId: String
    // Decoded as plain strings (see StrideCalibrationAck) so a future status/reason value this
    // build doesn't know about still decodes instead of failing the whole ACK. Absent on old
    // servers, which is also just `nil` here, not an error.
    let strideCalibration: StrideCalibrationAck?
}

nonisolated private struct AxisPayload: Codable {
    let x: Double?
    let y: Double?
    let z: Double?
}

nonisolated private struct Vector3Payload: Codable {
    let x: Double
    let y: Double
    let z: Double
}

nonisolated private struct QuaternionPayload: Codable {
    let x: Double
    let y: Double
    let z: Double
    let w: Double
}

/// Matches the server's `ArkitPose` zod schema (`arkit.dto.ts`) exactly — that schema is
/// `.strict()`, so no extra fields (not even a `clientSessionId`) may appear here. Queue
/// bookkeeping that needs a client-side correlation id lives on `QueuedArkitPose` instead.
nonisolated private struct ArkitPoseWire: Codable {
    let type = "arkit.pose"
    let schemaVersion = 1
    var sessionId: String
    let arSessionId: String
    let deviceId: String
    let sequence: Int
    let timestamp: Int64
    let frameTimestamp: Double
    let position: Vector3Payload
    let rotation: QuaternionPayload
    let trackingState: String
}

nonisolated private struct QueuedArkitPose: Codable, Identifiable {
    let clientSessionId: String
    var wire: ArkitPoseWire

    var id: String { "\(wire.arSessionId)-\(wire.sequence)" }
}

nonisolated private struct LocationPayload: Codable {
    let sequence: Int
    let timestamp: Date
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?
    let ellipsoidalAltitude: Double?
    let horizontalAccuracy: Double?
    let verticalAccuracy: Double?
    let speed: Double?
    let course: Double?
    let speedAccuracy: Double?
    let courseAccuracy: Double?
    let floor: Int?
    let appState: String
    let sensorSegmentId: String

    init(_ sample: LocationSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        latitude = sample.latitude.finiteOrNil
        longitude = sample.longitude.finiteOrNil
        altitude = sample.altitude.finiteOrNil
        ellipsoidalAltitude = sample.ellipsoidalAltitude?.finiteOrNil
        horizontalAccuracy = sample.horizontalAccuracy.finiteOrNil
        verticalAccuracy = sample.verticalAccuracy.finiteOrNil
        speed = sample.speed.finiteOrNil
        course = sample.course.finiteOrNil
        speedAccuracy = sample.speedAccuracy.finiteOrNil
        courseAccuracy = sample.courseAccuracy.finiteOrNil
        floor = sample.floor
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated private struct MotionPayload: Codable {
    let sequence: Int
    let timestamp: Date
    let userAcceleration: AxisPayload
    let rotationRate: AxisPayload
    let gravity: AxisPayload
    let attitude: AttitudePayload
    let appState: String
    let sensorSegmentId: String

    struct AttitudePayload: Codable {
        let roll: Double?
        let pitch: Double?
        let yaw: Double?
    }

    init(_ sample: MotionSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        userAcceleration = AxisPayload(x: sample.userAccelerationX.finiteOrNil, y: sample.userAccelerationY.finiteOrNil, z: sample.userAccelerationZ.finiteOrNil)
        rotationRate = AxisPayload(x: sample.rotationRateX.finiteOrNil, y: sample.rotationRateY.finiteOrNil, z: sample.rotationRateZ.finiteOrNil)
        gravity = AxisPayload(x: sample.gravityX.finiteOrNil, y: sample.gravityY.finiteOrNil, z: sample.gravityZ.finiteOrNil)
        attitude = AttitudePayload(roll: sample.attitudeRoll.finiteOrNil, pitch: sample.attitudePitch.finiteOrNil, yaw: sample.attitudeYaw.finiteOrNil)
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated private struct AltimeterPayload: Codable {
    let sequence: Int
    let timestamp: Date
    let relativeAltitude: Double?
    let pressure: Double?
    let appState: String
    let sensorSegmentId: String

    init(_ sample: AltimeterSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        relativeAltitude = sample.relativeAltitude.finiteOrNil
        pressure = sample.pressure.finiteOrNil
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated private struct PedometerPayload: Codable {
    let sequence: Int
    let timestamp: Date
    let captureSource: String
    let numberOfSteps: Int?
    let distance: Double?
    let currentPace: Double?
    let currentCadence: Double?
    let floorsAscended: Int?
    let floorsDescended: Int?
    let appState: String
    let sensorSegmentId: String

    init(_ sample: PedometerSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        captureSource = sample.captureSource.rawValue
        numberOfSteps = sample.numberOfSteps
        distance = sample.distance?.finiteOrNil
        currentPace = sample.currentPace?.finiteOrNil
        currentCadence = sample.currentCadence?.finiteOrNil
        floorsAscended = sample.floorsAscended
        floorsDescended = sample.floorsDescended
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated private struct TelemetryBatchPayload: Codable, Identifiable {
    let batchId: String
    var sessionId: String?
    let clientSessionId: String
    let createdAt: Date
    let locations: [LocationPayload]
    let motion: [MotionPayload]
    let altimeter: [AltimeterPayload]
    let pedometer: [PedometerPayload]

    var id: String { batchId }
}

nonisolated private struct MarkerPayload: Codable, Identifiable {
    let markerId: String
    var sessionId: String?
    let clientSessionId: String
    let timestamp: Date
    let type: String
    let note: String?
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?
    let ellipsoidalAltitude: Double? = nil
    let horizontalAccuracy: Double?
    let verticalAccuracy: Double?

    var id: String { markerId }
}

nonisolated struct LastSequencesPayload: Codable, Equatable {
    let location: Int
    let motion: Int
    let altimeter: Int
    let pedometer: Int
}

nonisolated private struct FinishPayload: Codable, Identifiable {
    let clientSessionId: String
    var sessionId: String?
    let endedAt: Date
    // Optional so a queue file persisted before this field existed still decodes instead of
    // throwing and silently dropping every queued upload (session starts, batches, markers).
    let lastSequences: LastSequencesPayload?
    let interrupted: Bool?

    var id: String { clientSessionId }
}

nonisolated private struct SyncCompletePayload: Codable {
    let clientSessionId: String
    let sessionId: String?
    let lastSequences: LastSequencesPayload
}

nonisolated private struct DiagnosticEventItem: Codable {
    let eventId: String
    let eventType: String
    let clientTimestamp: Date
    let metadata: [String: String]
}

nonisolated private struct QueuedDiagnosticEvent: Codable, Identifiable {
    let clientSessionId: String
    let event: DiagnosticEventItem

    var id: String { event.eventId }
}

nonisolated private struct DiagnosticEventPayload: Codable {
    let clientSessionId: String
    let events: [DiagnosticEventItem]
}

nonisolated private struct CollectorStatusPayload: Codable {
    let sessionId: String
    let collecting: Bool
    let locationSampleCount: Int
    let motionSampleCount: Int
    let pendingBatchCount: Int
}

/// Which collector + which server a queued session belongs to. Captured once per session at
/// `session:start` time and compared against the *live* current owner before every send: if the
/// app logs into a different collector or points at a different server, data recorded under the
/// old owner is held (never silently uploaded to the new one) until that owner is current again.
nonisolated struct UploadOwner: Codable, Equatable {
    let collectorId: String
    let serverKey: String
}

/// Server ACK error detail (`{ code, message, status, retryable, details }`), preserved instead of
/// collapsing every failure to a single Bool — `retryable` and `code` decide retry vs. quarantine.
nonisolated private struct AckError: Decodable {
    let code: String?
    let message: String?
    let status: Int?
    let retryable: Bool?
}

nonisolated private struct UploadQueueState: Codable {
    var sessionStarts: [String: SessionStartPayload] = [:]
    var serverSessionIds: [String: String] = [:]
    var sessionOwners: [String: UploadOwner] = [:]
    var telemetry: [TelemetryBatchPayload] = []
    var markers: [MarkerPayload] = []
    var finishes: [FinishPayload] = []
    var finishAcknowledged: [String: LastSequencesPayload] = [:]
    var syncCompleteAcknowledged: Set<String> = []
    var unsynchronizedSessions: Set<String> = []
    var diagnosticEvents: [QueuedDiagnosticEvent] = []
    var arkitPoses: [QueuedArkitPose] = []
    // Held forever (never deleted) alongside their item, same as a non-retryable item simply
    // being excluded from the "oldest pending" search below — kept for inspection, not auto-retried.
    var quarantinedSessionStarts: Set<String> = []
    var quarantinedBatchIds: Set<String> = []
    var quarantinedMarkerIds: Set<String> = []
    var quarantinedArkitPoseIds: Set<String> = []
    var quarantinedDiagnosticIds: Set<String> = []
    var quarantinedFinishIds: Set<String> = []
    var quarantinedSyncCompleteIds: Set<String> = []
    /// Items that already got one "clear serverSessionId + re-handshake" retry for a
    /// SESSION_NOT_FOUND/SESSION_NOT_STARTED ACK; a second such failure quarantines instead of
    /// looping forever.
    var sessionRestartRetried: Set<String> = []
    var lastErrorCodes: [String: String] = [:]

    init() {}

    // Manual Decodable so a queue file persisted before any of these keys existed still decodes
    // (missing key -> empty) instead of throwing and dropping every queued upload waiting to sync.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionStarts = try container.decodeIfPresent([String: SessionStartPayload].self, forKey: .sessionStarts) ?? [:]
        serverSessionIds = try container.decodeIfPresent([String: String].self, forKey: .serverSessionIds) ?? [:]
        sessionOwners = try container.decodeIfPresent([String: UploadOwner].self, forKey: .sessionOwners) ?? [:]
        telemetry = try container.decodeIfPresent([TelemetryBatchPayload].self, forKey: .telemetry) ?? []
        markers = try container.decodeIfPresent([MarkerPayload].self, forKey: .markers) ?? []
        finishes = try container.decodeIfPresent([FinishPayload].self, forKey: .finishes) ?? []
        finishAcknowledged = try container.decodeIfPresent([String: LastSequencesPayload].self, forKey: .finishAcknowledged) ?? [:]
        syncCompleteAcknowledged = try container.decodeIfPresent(Set<String>.self, forKey: .syncCompleteAcknowledged) ?? []
        unsynchronizedSessions = try container.decodeIfPresent(Set<String>.self, forKey: .unsynchronizedSessions) ?? []
        diagnosticEvents = try container.decodeIfPresent([QueuedDiagnosticEvent].self, forKey: .diagnosticEvents) ?? []
        arkitPoses = try container.decodeIfPresent([QueuedArkitPose].self, forKey: .arkitPoses) ?? []
        quarantinedSessionStarts = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedSessionStarts) ?? []
        quarantinedBatchIds = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedBatchIds) ?? []
        quarantinedMarkerIds = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedMarkerIds) ?? []
        quarantinedArkitPoseIds = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedArkitPoseIds) ?? []
        quarantinedDiagnosticIds = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedDiagnosticIds) ?? []
        quarantinedFinishIds = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedFinishIds) ?? []
        quarantinedSyncCompleteIds = try container.decodeIfPresent(Set<String>.self, forKey: .quarantinedSyncCompleteIds) ?? []
        sessionRestartRetried = try container.decodeIfPresent(Set<String>.self, forKey: .sessionRestartRetried) ?? []
        lastErrorCodes = try container.decodeIfPresent([String: String].self, forKey: .lastErrorCodes) ?? [:]
    }
}

private final class PersistentUploadQueue {
    private let url: URL
    private let encoder = TelemetrySyncCoordinator.makeEncoder()
    private let decoder = TelemetrySyncCoordinator.makeDecoder()
    private let storageQueue = DispatchQueue(label: "CampusTracker.upload-queue.storage", qos: .utility)
    private var pendingSave: DispatchWorkItem?
    var state: UploadQueueState

    /// `directoryOverride` exists so tests can point the queue at an isolated temporary directory
    /// instead of the app's real Application Support folder (which would otherwise leak state
    /// between test runs and, worse, between tests and whatever the app itself last persisted).
    init(fileManager: FileManager = .default, directoryOverride: URL? = nil) {
        let directory: URL
        if let directoryOverride {
            directory = directoryOverride
        } else {
            let support = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? fileManager.temporaryDirectory
            directory = support.appendingPathComponent("CampusCollector", isDirectory: true)
        }
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("pending_uploads.json")
        if let data = try? Data(contentsOf: url), let decoded = try? decoder.decode(UploadQueueState.self, from: data) {
            state = decoded
        } else {
            state = UploadQueueState()
        }
    }

    func save() {
        let snapshot = state
        pendingSave?.cancel()

        let workItem = DispatchWorkItem { [url, encoder] in
            do {
                let data = try encoder.encode(snapshot)
                try data.write(to: url, options: .atomic)
            } catch {
                let field: String
                if case let EncodingError.invalidValue(_, context) = error {
                    field = context.codingPath.map(\.stringValue).joined(separator: ".")
                } else {
                    field = "unknown"
                }
                print("[UploadQueue] persistence failed field=\(field) error=\(String(reflecting: error))")
            }
        }
        pendingSave = workItem

        // Rapid ACKs previously re-encoded the entire backlog on the main actor.
        // Coalescing adjacent snapshots keeps UI updates responsive while preserving
        // the newest durable queue state.
        storageQueue.asyncAfter(deadline: .now() + 0.1, execute: workItem)
    }

    /// Non-quarantined work across every owner. UI-facing counts are filtered by the live owner
    /// in `TelemetrySyncCoordinator`, so held work is never presented as sendable.
    var pendingCount: Int {
        (state.telemetry.count - state.quarantinedBatchIds.count)
        + (state.markers.count - state.quarantinedMarkerIds.count)
        + (state.finishes.count - state.quarantinedFinishIds.count)
        + (state.diagnosticEvents.count - state.quarantinedDiagnosticIds.count)
        + (state.arkitPoses.count - state.quarantinedArkitPoseIds.count)
        + state.finishAcknowledged.keys.filter { !state.syncCompleteAcknowledged.contains($0) && !state.unsynchronizedSessions.contains($0) }.count
    }

    var quarantinedCount: Int {
        state.quarantinedBatchIds.count + state.quarantinedMarkerIds.count + state.quarantinedFinishIds.count
        + state.quarantinedDiagnosticIds.count + state.quarantinedArkitPoseIds.count
        + state.quarantinedSyncCompleteIds.count
    }
}

@MainActor
final class TelemetrySyncCoordinator {
    var onPendingCountChanged: ((Int) -> Void)?
    var onQuarantinedCountChanged: ((Int) -> Void)?
    var onHeldCountChanged: ((Int) -> Void)?
    var onUnsynchronizedCountChanged: ((Int) -> Void)?
    var onServerSessionStarted: ((UUID, String) -> Void)?
    var onArkitBufferOverflow: (() -> Void)?

    /// At 20Hz this is ~5 minutes of buffering before oldest poses start being dropped.
    private static let maxQueuedArkitPoses = 6000
    private static let sessionRestartCodes: Set<String> = ["SESSION_NOT_FOUND", "SESSION_NOT_STARTED"]
    private static let ackTimeoutSeconds: TimeInterval = 10
    private static let retryDelaySeconds: TimeInterval = 2

    private let webSocket: CollectorSocket
    private let queue: PersistentUploadQueue
    private var locations: [LocationPayload] = []
    private var motion: [MotionPayload] = []
    private var altimeter: [AltimeterPayload] = []
    private var pedometer: [PedometerPayload] = []
    private var activeSession: CollectionSession?
    private var batchTimer: Timer?
    private var statusTimer: Timer?
    private var sampleCounts = SampleCounts()
    private let encodingQueue = DispatchQueue(label: "CampusTracker.websocket.encoding", qos: .userInitiated)

    /// Which collector+server is currently logged in, set by `CollectionCoordinator` from auth
    /// state (not just at session start): gates every send, including leftovers from a previous
    /// run, so a login/server change never uploads stale data to the wrong place.
    private var owner: UploadOwner?

    private struct InFlight {
        let requestId: String
        var timeout: DispatchWorkItem?
        let completion: (Bool, AckError?, Data?) -> Void
    }
    /// Exactly one request in flight at a time, oldest-eligible-item-first. Replaces an earlier
    /// design that tracked in-flight requests in a `Set`, which let a newer batch's ACK commit
    /// before an older, still-in-flight batch's — the confirmed cause of out-of-order server
    /// writes under any concurrent/overlapping `synchronize()` call (slow ACKs, reconnects, the
    /// 1s batch timer firing while a previous batch was still awaiting its ACK).
    private var inFlight: InFlight?
    private var retryBackoff: DispatchWorkItem?
    private var reportedOrphanSessions: Set<String> = []

    var pendingCount: Int { countSummary.sendable }
    var heldCount: Int { countSummary.held }
    var quarantinedCount: Int { queue.quarantinedCount }
    var unsynchronizedCount: Int { queue.state.unsynchronizedSessions.count }

    private var countSummary: (sendable: Int, held: Int) {
        let sessions = allPendingSessionIDs()
        guard let owner else { return (0, queue.pendingCount) }
        let eligible = Set(queue.state.sessionOwners.filter { $0.value == owner }.keys)
        let sendable = sessions.reduce(0) { $0 + nonQuarantinedItemCount(for: $1, includeSyncComplete: true) }
        let eligibleCount = sessions.filter { eligible.contains($0) }.reduce(0) { $0 + nonQuarantinedItemCount(for: $1, includeSyncComplete: true) }
        return (eligibleCount, max(0, sendable - eligibleCount))
    }

    init(webSocket: CollectorSocket, queueDirectory: URL? = nil) {
        self.webSocket = webSocket
        self.queue = PersistentUploadQueue(directoryOverride: queueDirectory)
        webSocket.onConnected = { [weak self] in self?.handleConnected() }
        webSocket.onDisconnected = { [weak self] in self?.handleDisconnected() }
        webSocket.onTextMessage = { [weak self] in self?.handle(message: $0) }
        notifyCount()
    }

    /// Called whenever the authenticated collector or configured server changes (login, logout,
    /// server address edit) — independent of any particular session. A fresh non-nil owner also
    /// retries any session:start this process previously gave up on, mirroring a fresh login.
    func updateOwner(_ newOwner: UploadOwner?) {
        owner = newOwner
        if newOwner != nil { queue.state.quarantinedSessionStarts.removeAll() }
        synchronize()
    }

    func start(session: CollectionSession, device: DeviceInfo, owner: UploadOwner, active: Bool = true) {
        if active { activeSession = session }
        self.owner = owner
        let payload = SessionStartPayload(
            clientSessionId: session.id.uuidString,
            deviceId: device.deviceId.uuidString,
            deviceModel: device.deviceModel,
            systemVersion: device.systemVersion,
            appVersion: device.appVersion,
            sensorCapabilities: session.sensorCapabilities,
            startedAt: session.startedAt,
            strideCalibration: session.strideCalibration
        )
        queue.state.sessionStarts[session.id.uuidString] = payload
        queue.state.sessionOwners[session.id.uuidString] = owner
        queue.save()
        if active {
            startBatchTimer()
            startStatusTimer()
        }
        synchronize()
    }

    func finish(session: CollectionSession, lastSequences: LastSequencesPayload, interrupted: Bool = false) {
        flushBatch()
        batchTimer?.invalidate()
        batchTimer = nil
        statusTimer?.invalidate()
        statusTimer = nil
        let id = session.id.uuidString
        if !queue.state.finishes.contains(where: { $0.clientSessionId == id }) {
            queue.state.finishes.append(FinishPayload(clientSessionId: id, sessionId: queue.state.serverSessionIds[id], endedAt: session.endedAt ?? Date(), lastSequences: lastSequences, interrupted: interrupted))
            queue.save()
        }
        activeSession = nil
        synchronize()
    }

    func append(location: LocationSample, session: CollectionSession) { locations.append(LocationPayload(location)); flushIfNeeded() }
    func append(motion: MotionSample, session: CollectionSession) { self.motion.append(MotionPayload(motion)); flushIfNeeded() }
    func append(altimeter: AltimeterSample, session: CollectionSession) { self.altimeter.append(AltimeterPayload(altimeter)); flushIfNeeded() }
    func append(pedometer: PedometerSample, session: CollectionSession) { self.pedometer.append(PedometerPayload(pedometer)); flushIfNeeded() }

    func append(marker: EventMarker, session: CollectionSession) {
        queue.state.markers.append(MarkerPayload(
            markerId: marker.id.uuidString,
            sessionId: queue.state.serverSessionIds[session.id.uuidString],
            clientSessionId: session.id.uuidString,
            timestamp: marker.timestamp,
            type: marker.type.rawValue,
            note: marker.note,
            latitude: marker.latitude?.finiteOrNil,
            longitude: marker.longitude?.finiteOrNil,
            altitude: marker.altitude?.finiteOrNil,
            horizontalAccuracy: marker.horizontalAccuracy?.finiteOrNil,
            verticalAccuracy: marker.verticalAccuracy?.finiteOrNil
        ))
        queue.save()
        notifyCount()
        synchronize()
    }

    /// `sessionId` is resolved lazily (same as telemetry batches/markers): it's filled in with the
    /// server session id right before the first send attempt, once `session:start` has ACKed.
    func append(arkitPose pose: ARKitPoseSample, measuredAt: Date, session: CollectionSession) {
        let wire = ArkitPoseWire(
            sessionId: queue.state.serverSessionIds[session.id.uuidString] ?? "",
            arSessionId: pose.arSessionId.uuidString,
            deviceId: session.deviceId.uuidString,
            sequence: pose.sequence,
            timestamp: Int64((measuredAt.timeIntervalSince1970 * 1_000).rounded()),
            frameTimestamp: pose.frameTimestamp,
            position: Vector3Payload(x: pose.positionX, y: pose.positionY, z: pose.positionZ),
            rotation: QuaternionPayload(x: pose.rotationX, y: pose.rotationY, z: pose.rotationZ, w: pose.rotationW),
            trackingState: pose.trackingState.rawValue
        )
        queue.state.arkitPoses.append(QueuedArkitPose(clientSessionId: session.id.uuidString, wire: wire))
        if queue.state.arkitPoses.count > Self.maxQueuedArkitPoses {
            queue.state.arkitPoses.removeFirst(queue.state.arkitPoses.count - Self.maxQueuedArkitPoses)
            onArkitBufferOverflow?()
        }
        queue.save()
        notifyCount()
        synchronize()
    }

    func update(sampleCounts: SampleCounts) {
        self.sampleCounts = sampleCounts
    }

    /// Local-first diagnostic events: not fusion input, used by the server only to explain gaps
    /// and restarts. Queued the same way as markers/finishes so they survive app restarts and
    /// disconnects, deduplicated server-side by `eventId`.
    func logDiagnostic(eventType: String, metadata: [String: String] = [:], clientSessionId: String? = nil) {
        guard let id = clientSessionId ?? activeSession?.id.uuidString else { return }
        queue.state.diagnosticEvents.append(QueuedDiagnosticEvent(
            clientSessionId: id,
            event: DiagnosticEventItem(eventId: UUID().uuidString, eventType: eventType, clientTimestamp: Date(), metadata: metadata)
        ))
        queue.save()
        notifyCount()
        synchronize()
    }

    private func startBatchTimer() {
        batchTimer?.invalidate()
        batchTimer = Timer.scheduledTimer(
            timeInterval: 1,
            target: self,
            selector: #selector(flushBatch),
            userInfo: nil,
            repeats: true
        )
    }

    private func startStatusTimer() {
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(
            timeInterval: 7,
            target: self,
            selector: #selector(sendStatus),
            userInfo: nil,
            repeats: true
        )
    }

    private func flushIfNeeded() {
        if locations.count + motion.count + altimeter.count + pedometer.count >= 64 { flushBatch() }
    }

    @objc private func flushBatch() {
        guard let session = activeSession, !(locations.isEmpty && motion.isEmpty && altimeter.isEmpty && pedometer.isEmpty) else { return }
        print("[UploadQueue] flush session=\(session.id.uuidString) samples location=\(locations.count) motion=\(motion.count) altimeter=\(altimeter.count) pedometer=\(pedometer.count)")
        queue.state.telemetry.append(TelemetryBatchPayload(
            batchId: UUID().uuidString,
            sessionId: queue.state.serverSessionIds[session.id.uuidString],
            clientSessionId: session.id.uuidString,
            createdAt: Date(),
            locations: locations,
            motion: motion,
            altimeter: altimeter,
            pedometer: pedometer
        ))
        locations.removeAll(keepingCapacity: true)
        motion.removeAll(keepingCapacity: true)
        altimeter.removeAll(keepingCapacity: true)
        pedometer.removeAll(keepingCapacity: true)
        queue.save()
        notifyCount()
        synchronize()
    }

    private func synchronize() {
        guard inFlight == nil else { return }
        for id in queue.state.syncCompleteAcknowledged { cleanupSessionIfPossible(id) }
        let orphaned = allPendingSessionIDs().filter { queue.state.sessionOwners[$0] == nil }
        for id in orphaned where reportedOrphanSessions.insert(id).inserted {
            print("[Diagnostics] UPLOAD_ORPHANED clientSessionId=\(id) reason=missing_session_owner")
        }
        print("[UploadQueue] flush start state=\(webSocket.state.label) pending=\(queue.pendingCount) starts=\(queue.state.sessionStarts.count)")
        guard webSocket.state == .connected else {
            print("[UploadQueue] flush paused: WebSocket is not connected")
            return
        }
        guard let currentOwner = owner else {
            print("[UploadQueue] flush paused: no authenticated owner yet")
            return
        }
        let eligible = Set(queue.state.sessionOwners.filter { $0.value == currentOwner }.keys)
        // A finishing session gets its own lane: drain only that session, then finish and
        // syncComplete. Backlog from another session must not delay its termination barrier.
        let finishing = queue.state.finishes.first(where: { eligible.contains($0.clientSessionId) })?.clientSessionId
        let awaitingSync = queue.state.finishAcknowledged.keys.first(where: {
            eligible.contains($0) && !queue.state.syncCompleteAcknowledged.contains($0) && !queue.state.unsynchronizedSessions.contains($0)
        })
        let scoped = finishing ?? awaitingSync
        sendMissingSessionStarts(eligible: scoped.map { [$0] } ?? eligible)
    }

    private func handleConnected() {
        // A reconnect must repeat session:start with the same clientSessionId so the
        // server can restore (rather than replace) the active session.
        if let id = activeSession?.id.uuidString {
            queue.state.serverSessionIds.removeValue(forKey: id)
            queue.save()
            print("[UploadQueue] reconnect handshake required clientSessionId=\(id)")
        }
        synchronize()
    }

    private func handleDisconnected() {
        print("[UploadQueue] WebSocket disconnected; retaining pending=\(queue.pendingCount)")
        if let current = inFlight {
            current.timeout?.cancel()
            inFlight = nil
            current.completion(false, nil, nil)
        }
    }

    private func sendMissingSessionStarts(eligible: Set<String>) {
        guard let pair = queue.state.sessionStarts.first(where: {
            eligible.contains($0.key)
                && queue.state.serverSessionIds[$0.key] == nil
                && !queue.state.quarantinedSessionStarts.contains($0.key)
        }) else {
            sendNextTelemetry(eligible: eligible)
            return
        }
        let key = pair.key
        print("[UploadQueue] sending session:start clientSessionId=\(key)")
        dispatch(type: "session:start", payload: pair.value, itemID: key) { [weak self] ok, error, data in
            guard let self = self else { return }
            if ok, let data = data, let response = try? Self.makeDecoder().decode(SessionStartResponse.self, from: data) {
                self.queue.state.serverSessionIds[key] = response.sessionId
                self.queue.save()
                print("[UploadQueue] session:start ACK serverSessionId=\(response.sessionId)")
                if let ack = response.strideCalibration {
                    print("[UploadQueue] session:start ACK strideCalibration status=\(ack.status) reason=\(ack.reason ?? "—")")
                }
                if let uuid = UUID(uuidString: key) { self.onServerSessionStarted?(uuid, response.sessionId) }
                self.sendStatus()
                self.synchronize()
                return
            }
            if ok {
                print("[UploadQueue] session:start ACK missing data.sessionId clientSessionId=\(key)")
                self.scheduleRetry()
            } else if self.isRetryable(error) {
                self.scheduleRetry()
            } else {
                // Held, not deleted: retried automatically on the next login/server change (updateOwner).
                print("[UploadQueue] session:start rejected code=\(error?.code ?? "—"); holding clientSessionId=\(key)")
                self.queue.state.quarantinedSessionStarts.insert(key)
                self.queue.save()
                self.synchronize()
            }
        }
    }

    private func sendNextTelemetry(eligible: Set<String>) {
        guard let index = queue.state.telemetry.firstIndex(where: {
            eligible.contains($0.clientSessionId) && !queue.state.quarantinedBatchIds.contains($0.batchId)
        }) else {
            sendNextMarker(eligible: eligible)
            return
        }
        var batch = queue.state.telemetry[index]
        guard let serverSessionId = batch.sessionId ?? queue.state.serverSessionIds[batch.clientSessionId] else {
            print("[UploadQueue] blocked telemetry:batch batchId=\(batch.batchId) clientSessionId=\(batch.clientSessionId): no persisted server sessionId; preserving oldest-first order")
            return
        }
        batch.sessionId = serverSessionId
        queue.state.telemetry[index] = batch
        queue.save()
        print("[UploadQueue] sending telemetry:batch batchId=\(batch.batchId)")
        dispatch(type: "telemetry:batch", payload: batch, itemID: batch.batchId) { [weak self] ok, error, _ in
            guard let self = self else { return }
            if ok {
                if let index = self.queue.state.telemetry.firstIndex(where: { $0.batchId == batch.batchId }) {
                    self.queue.state.telemetry.remove(at: index)
                    self.queue.save()
                    self.notifyCount()
                }
                self.synchronize()
                return
            }
            self.handleItemFailure(error: error, itemId: batch.batchId, clientSessionId: batch.clientSessionId, quarantine: \.quarantinedBatchIds)
        }
    }

    private func sendNextMarker(eligible: Set<String>) {
        guard let index = queue.state.markers.firstIndex(where: {
            eligible.contains($0.clientSessionId) && !queue.state.quarantinedMarkerIds.contains($0.markerId)
        }) else {
            sendNextArkitPose(eligible: eligible)
            return
        }
        var marker = queue.state.markers[index]
        guard let serverSessionId = marker.sessionId ?? queue.state.serverSessionIds[marker.clientSessionId] else {
            print("[UploadQueue] blocked marker:create markerId=\(marker.markerId) clientSessionId=\(marker.clientSessionId): no persisted server sessionId; preserving oldest-first order")
            return
        }
        marker.sessionId = serverSessionId
        queue.state.markers[index] = marker
        queue.save()
        print("[UploadQueue] sending marker:create markerId=\(marker.markerId)")
        dispatch(type: "marker:create", payload: marker, itemID: marker.markerId) { [weak self] ok, error, _ in
            guard let self = self else { return }
            if ok {
                if let index = self.queue.state.markers.firstIndex(where: { $0.markerId == marker.markerId }) {
                    self.queue.state.markers.remove(at: index)
                    self.queue.save()
                    self.notifyCount()
                }
                self.synchronize()
                return
            }
            self.handleItemFailure(error: error, itemId: marker.markerId, clientSessionId: marker.clientSessionId, quarantine: \.quarantinedMarkerIds)
        }
    }

    private func sendNextArkitPose(eligible: Set<String>) {
        guard let index = queue.state.arkitPoses.firstIndex(where: {
            eligible.contains($0.clientSessionId) && !queue.state.quarantinedArkitPoseIds.contains($0.id)
        }) else {
            sendNextDiagnosticEvent(eligible: eligible)
            return
        }
        var queued = queue.state.arkitPoses[index]
        guard let serverSessionId = queue.state.serverSessionIds[queued.clientSessionId] else {
            print("[UploadQueue] blocked arkit:pose id=\(queued.id) clientSessionId=\(queued.clientSessionId): no persisted server sessionId; preserving oldest-first order")
            return
        }
        queued.wire.sessionId = serverSessionId
        queue.state.arkitPoses[index] = queued
        queue.save()
        dispatch(type: "arkit:pose", payload: queued.wire, itemID: queued.id) { [weak self] ok, error, _ in
            guard let self = self else { return }
            if ok {
                if let index = self.queue.state.arkitPoses.firstIndex(where: { $0.id == queued.id }) {
                    self.queue.state.arkitPoses.remove(at: index)
                    self.queue.save()
                    self.notifyCount()
                }
                self.synchronize()
                return
            }
            self.handleItemFailure(error: error, itemId: queued.id, clientSessionId: queued.clientSessionId, quarantine: \.quarantinedArkitPoseIds)
        }
    }

    private func sendNextFinish(eligible: Set<String>) {
        guard let index = queue.state.finishes.firstIndex(where: {
            eligible.contains($0.clientSessionId) && !queue.state.quarantinedFinishIds.contains($0.clientSessionId)
        }) else {
            sendNextSyncComplete(eligible: eligible)
            return
        }
        var finish = queue.state.finishes[index]
        guard let serverSessionId = finish.sessionId ?? queue.state.serverSessionIds[finish.clientSessionId] else {
            print("[UploadQueue] blocked session:finish clientSessionId=\(finish.clientSessionId): no persisted server sessionId")
            return
        }
        finish.sessionId = serverSessionId
        queue.state.finishes[index] = finish
        queue.save()
        print("[UploadQueue] sending session:finish clientSessionId=\(finish.clientSessionId)")
        dispatch(type: "session:finish", payload: finish, itemID: finish.clientSessionId) { [weak self] ok, error, _ in
            guard let self = self else { return }
            if ok {
                if let index = self.queue.state.finishes.firstIndex(where: { $0.clientSessionId == finish.clientSessionId }) {
                    self.queue.state.finishes.remove(at: index)
                    if let lastSequences = finish.lastSequences {
                        self.queue.state.finishAcknowledged[finish.clientSessionId] = lastSequences
                    }
                    self.queue.save()
                    self.notifyCount()
                    self.logDiagnostic(eventType: "SESSION_FINISH_ACK", clientSessionId: finish.clientSessionId)
                }
                self.synchronize()
                return
            }
            self.handleItemFailure(error: error, itemId: finish.clientSessionId, clientSessionId: finish.clientSessionId, quarantine: \.quarantinedFinishIds)
        }
    }

    private func sendNextDiagnosticEvent(eligible: Set<String>) {
        guard let index = queue.state.diagnosticEvents.firstIndex(where: {
            eligible.contains($0.clientSessionId) && !queue.state.quarantinedDiagnosticIds.contains($0.event.eventId)
        }) else {
            sendNextFinish(eligible: eligible)
            return
        }
        let queued = queue.state.diagnosticEvents[index]
        print("[UploadQueue] sending diagnostic:event eventId=\(queued.event.eventId) type=\(queued.event.eventType)")
        let payload = DiagnosticEventPayload(clientSessionId: queued.clientSessionId, events: [queued.event])
        dispatch(type: "diagnostic:event", payload: payload, itemID: queued.event.eventId) { [weak self] ok, error, _ in
            guard let self = self else { return }
            if ok {
                if let index = self.queue.state.diagnosticEvents.firstIndex(where: { $0.event.eventId == queued.event.eventId }) {
                    self.queue.state.diagnosticEvents.remove(at: index)
                    self.queue.save()
                    self.notifyCount()
                }
                self.synchronize()
                return
            }
            self.handleItemFailure(error: error, itemId: queued.event.eventId, clientSessionId: queued.clientSessionId, quarantine: \.quarantinedDiagnosticIds)
        }
    }

    private func sendNextSyncComplete(eligible: Set<String>) {
        guard let pair = queue.state.finishAcknowledged.first(where: {
            eligible.contains($0.key)
                && !queue.state.syncCompleteAcknowledged.contains($0.key)
                && !queue.state.unsynchronizedSessions.contains($0.key)
                && nonQuarantinedItemCount(for: $0.key, includeSyncComplete: false) == 0
        }) else { return }
        let id = pair.key
        let payload = SyncCompletePayload(clientSessionId: id, sessionId: queue.state.serverSessionIds[id], lastSequences: pair.value)
        dispatch(type: "session:syncComplete", payload: payload, itemID: id) { [weak self] ok, error, data in
            guard let self else { return }
            if ok, let data,
               let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               (object["synchronized"] as? Bool) == false {
                self.queue.state.unsynchronizedSessions.insert(id)
                let differences = String(data: data, encoding: .utf8) ?? "unreadable"
                self.logDiagnostic(eventType: "SYNC_INCOMPLETE", metadata: ["manifest": differences], clientSessionId: id)
                self.queue.save()
                self.notifyCount()
                return
            }
            if ok {
                self.queue.state.syncCompleteAcknowledged.insert(id)
                self.logDiagnostic(eventType: "SYNC_COMPLETE_ACK", clientSessionId: id)
                self.cleanupSessionIfPossible(id)
                self.queue.save()
                self.notifyCount()
                self.synchronize()
            } else {
                self.handleItemFailure(error: error, itemId: id, clientSessionId: id, quarantine: \.quarantinedSyncCompleteIds)
            }
        }
    }

    private func allPendingSessionIDs() -> Set<String> {
        Set(queue.state.telemetry.map(\.clientSessionId)
            + queue.state.markers.map(\.clientSessionId)
            + queue.state.finishes.map(\.clientSessionId)
            + queue.state.diagnosticEvents.map(\.clientSessionId)
            + queue.state.arkitPoses.map(\.clientSessionId)
            + Array(queue.state.finishAcknowledged.keys))
    }

    private func nonQuarantinedItemCount(for id: String, includeSyncComplete: Bool) -> Int {
        var count = queue.state.telemetry.filter { $0.clientSessionId == id && !queue.state.quarantinedBatchIds.contains($0.batchId) }.count
        count += queue.state.markers.filter { $0.clientSessionId == id && !queue.state.quarantinedMarkerIds.contains($0.markerId) }.count
        count += queue.state.finishes.filter { $0.clientSessionId == id && !queue.state.quarantinedFinishIds.contains($0.clientSessionId) }.count
        count += queue.state.diagnosticEvents.filter { $0.clientSessionId == id && !queue.state.quarantinedDiagnosticIds.contains($0.event.eventId) }.count
        count += queue.state.arkitPoses.filter { $0.clientSessionId == id && !queue.state.quarantinedArkitPoseIds.contains($0.id) }.count
        if includeSyncComplete,
           queue.state.finishAcknowledged[id] != nil,
           !queue.state.syncCompleteAcknowledged.contains(id),
           !queue.state.unsynchronizedSessions.contains(id),
           !queue.state.quarantinedSyncCompleteIds.contains(id) { count += 1 }
        return count
    }

    private func quarantinedItemCount(for id: String) -> Int {
        queue.state.telemetry.filter { $0.clientSessionId == id && queue.state.quarantinedBatchIds.contains($0.batchId) }.count
        + queue.state.markers.filter { $0.clientSessionId == id && queue.state.quarantinedMarkerIds.contains($0.markerId) }.count
        + queue.state.finishes.filter { $0.clientSessionId == id && queue.state.quarantinedFinishIds.contains($0.clientSessionId) }.count
        + queue.state.diagnosticEvents.filter { $0.clientSessionId == id && queue.state.quarantinedDiagnosticIds.contains($0.event.eventId) }.count
        + queue.state.arkitPoses.filter { $0.clientSessionId == id && queue.state.quarantinedArkitPoseIds.contains($0.id) }.count
        + (queue.state.quarantinedSyncCompleteIds.contains(id) ? 1 : 0)
    }

    private func cleanupSessionIfPossible(_ id: String) {
        guard queue.state.syncCompleteAcknowledged.contains(id),
              nonQuarantinedItemCount(for: id, includeSyncComplete: false) == 0,
              quarantinedItemCount(for: id) == 0 else { return }
        queue.state.sessionStarts.removeValue(forKey: id)
        queue.state.serverSessionIds.removeValue(forKey: id)
        queue.state.sessionOwners.removeValue(forKey: id)
        queue.state.finishAcknowledged.removeValue(forKey: id)
        queue.state.syncCompleteAcknowledged.remove(id)
        queue.state.sessionRestartRetried = queue.state.sessionRestartRetried.filter { !$0.contains(id) }
        print("[UploadQueue] cleaned completed session clientSessionId=\(id)")
    }

    /// Shared post-failure handling for any queued item tied to a session: one re-handshake retry
    /// for a session-restart error, bounded backoff for anything else retryable, quarantine (held,
    /// never auto-retried again) for a confirmed-permanent rejection.
    private func handleItemFailure(
        error: AckError?,
        itemId: String,
        clientSessionId: String,
        quarantine keyPath: WritableKeyPath<UploadQueueState, Set<String>>
    ) {
        if let code = error?.code, Self.sessionRestartCodes.contains(code) {
            if !queue.state.sessionRestartRetried.contains(itemId) {
                print("[UploadQueue] \(code) for item=\(itemId); re-sending session:start then retrying once")
                queue.state.sessionRestartRetried.insert(itemId)
                queue.state.serverSessionIds.removeValue(forKey: clientSessionId)
                queue.save()
                synchronize()
            } else {
                quarantineItem(itemId: itemId, code: code, keyPath: keyPath)
            }
            return
        }
        if isRetryable(error) {
            if let code = error?.code {
                queue.state.lastErrorCodes[itemId] = code
                queue.save()
            }
            scheduleRetry()
        } else {
            quarantineItem(itemId: itemId, code: error?.code, keyPath: keyPath)
        }
    }

    private func quarantineItem(itemId: String, code: String?, keyPath: WritableKeyPath<UploadQueueState, Set<String>>) {
        print("[UploadQueue] quarantined item=\(itemId) code=\(code ?? "UNKNOWN")")
        queue.state[keyPath: keyPath].insert(itemId)
        queue.state.lastErrorCodes[itemId] = code ?? "UNKNOWN"
        queue.save()
        notifyCount()
        synchronize()
    }

    /// `retryable: true` (or any 5xx-shaped error, or no structured error at all — a timeout,
    /// disconnect, or local encode failure) keeps the item queued. Only a confirmed
    /// `retryable: false` (or 4xx) quarantines it.
    private func isRetryable(_ error: AckError?) -> Bool {
        guard let error else { return true }
        if let retryable = error.retryable { return retryable }
        return (error.status ?? 500) >= 500
    }

    private func scheduleRetry() {
        guard retryBackoff == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.retryBackoff = nil
            self?.synchronize()
        }
        retryBackoff = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelaySeconds, execute: work)
    }

    @objc private func sendStatus() {
        guard webSocket.state == .connected,
              let session = activeSession,
              let serverSessionId = queue.state.serverSessionIds[session.id.uuidString] else { return }
        let payload = CollectorStatusPayload(
            sessionId: serverSessionId,
            collecting: true,
            locationSampleCount: sampleCounts.location,
            motionSampleCount: sampleCounts.motion,
            pendingBatchCount: queue.state.telemetry.count
        )
        // Fire-and-forget: doesn't go through `inFlight` (has no retry/queue semantics of its own)
        // and must never block the real upload chain behind it.
        let requestId = UUID().uuidString
        let request = WebSocketRequest(requestId: requestId, type: "collector:status", payload: payload)
        encodingQueue.async { [weak self] in
            guard let data = try? Self.makeEncoder().encode(request), let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.webSocket.send(text: text) { _ in } }
        }
    }

    /// Sends exactly one request and routes its eventual resolution (ACK, timeout, send failure,
    /// or encode failure) through `resolve`, which is the single place that clears `inFlight` and
    /// invokes `completion`. Callers must only call this when `inFlight == nil` (true for every
    /// `sendNext*`/`sendMissingSessionStarts` call site, which are only reached from `synchronize()`
    /// right after that same check).
    private func dispatch<Payload: Encodable>(type: String, payload: Payload, itemID: String, completion: @escaping (Bool, AckError?, Data?) -> Void) {
        let requestId = UUID().uuidString
        inFlight = InFlight(requestId: requestId, timeout: nil, completion: completion)
        let request = WebSocketRequest(requestId: requestId, type: type, payload: payload)

        encodingQueue.async { [weak self] in
            let result: Result<Data, Error>
            do {
                result = .success(try Self.makeEncoder().encode(request))
            } catch {
                result = .failure(error)
            }

            DispatchQueue.main.async {
                guard let self = self else { return }
                switch result {
                case let .failure(error):
                    let field: String
                    if case let EncodingError.invalidValue(_, context) = error {
                        field = context.codingPath.map(\.stringValue).joined(separator: ".")
                    } else {
                        field = "unknown"
                    }
                    print("[WebSocket] JSON encode failed type=\(type) item=\(itemID) field=\(field) error=\(String(reflecting: error))")
                    self.resolve(requestId: requestId, ok: false, error: nil, data: nil)

                case let .success(data):
                    guard let text = String(data: data, encoding: .utf8) else {
                        print("[WebSocket] UTF-8 conversion failed type=\(type) item=\(itemID)")
                        self.resolve(requestId: requestId, ok: false, error: nil, data: nil)
                        return
                    }
                    print("[WebSocket] send type=\(type) requestId=\(requestId) item=\(itemID) bytes=\(data.count)")
                    let timeout = DispatchWorkItem { [weak self] in
                        print("[WebSocket] ACK timeout type=\(type) requestId=\(requestId) item=\(itemID); will resend with the same ID")
                        self?.resolve(requestId: requestId, ok: false, error: nil, data: nil)
                    }
                    self.inFlight?.timeout = timeout
                    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeoutSeconds, execute: timeout)
                    self.webSocket.send(text: text) { [weak self] error in
                        DispatchQueue.main.async {
                            guard let self = self else { return }
                            if let error = error {
                                print("[WebSocket] send completed type=\(type) requestId=\(requestId) error=\(error.localizedDescription)")
                                self.resolve(requestId: requestId, ok: false, error: nil, data: nil)
                            } else {
                                print("[WebSocket] send completed type=\(type) requestId=\(requestId) error=nil")
                            }
                        }
                    }
                }
            }
        }
    }

    private func handle(message text: String) {
        guard let data = text.data(using: .utf8), let ack = try? Self.makeDecoder().decode(WebSocketAck.self, from: data) else {
            print("[WebSocket] ignored non-ACK message bytes=\(text.utf8.count)")
            return
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let responseData = object?["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        let errorData = (object?["error"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        let error = errorData.flatMap { try? JSONDecoder().decode(AckError.self, from: $0) }
        let duplicate = (object?["duplicate"] as? Bool) ?? ((object?["data"] as? [String: Any])?["duplicate"] as? Bool) ?? false
        print("[WebSocket] ACK requestId=\(ack.requestId) ok=\(ack.ok) duplicate=\(duplicate) errorCode=\(error?.code ?? "—") retryable=\(error?.retryable.map(String.init) ?? "—")")
        resolve(requestId: ack.requestId, ok: ack.ok, error: error, data: responseData)
    }

    /// The only place `inFlight` is cleared and a stored completion invoked — so a late/duplicate
    /// resolution for a request that's no longer in flight (e.g. a stale ACK arriving after its
    /// own timeout already fired, or after a disconnect already failed it) is safely ignored by
    /// the `requestId` match below, instead of double-resolving or corrupting the next request.
    private func resolve(requestId: String, ok: Bool, error: AckError?, data: Data?) {
        guard let current = inFlight, current.requestId == requestId else {
            print("[WebSocket] ignored resolution for a request not in flight requestId=\(requestId) ok=\(ok)")
            return
        }
        current.timeout?.cancel()
        inFlight = nil
        current.completion(ok, error, data)
    }

    private func notifyCount() {
        onPendingCountChanged?(pendingCount)
        onQuarantinedCountChanged?(queue.quarantinedCount)
        onHeldCountChanged?(heldCount)
        onUnsynchronizedCountChanged?(unsynchronizedCount)
    }

    nonisolated static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }

    nonisolated static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = formatter.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 date")
            }
            return date
        }
        return decoder
    }
}
