import Combine
import CoreLocation
import CoreMotion
import Foundation
import UIKit

@MainActor
final class CollectionCoordinator: NSObject, ObservableObject {
    @Published private(set) var activeSession: CollectionSession?
    @Published private(set) var capabilities = SensorCapabilityDetector.detect()
    @Published private(set) var latestLocation: LocationSample?
    @Published private(set) var latestRelativeAltitude: Double?
    @Published private(set) var latestStepCount: Int?
    @Published private(set) var uiCounts = SampleCounts()
    @Published private(set) var locationAuthorization: CLAuthorizationStatus
    @Published private(set) var pendingUploadCount = 0
    @Published private(set) var appState: CollectorAppState = .foreground
    @Published private(set) var interruptedCollection: ActiveCollectionState?
    @Published private(set) var lastPersistedAt: Date?
    @Published private(set) var diagnostics: CollectionDiagnostics?

    private let repository: SensorDataRepository
    private let activeCollectionStore = ActiveCollectionStore()
    private let locationService = LocationService()
    private let motionService = MotionService()
    private let altimeterService = AltimeterService()
    private let pedometerService = PedometerService()
    private let bootTime = Date().addingTimeInterval(-ProcessInfo.processInfo.systemUptime)
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

    var isBackgroundCollectionEnabled: Bool { activeSession != nil && locationService.isActive }
    var isLocationActive: Bool { locationService.isActive }
    var isMotionActive: Bool { motionService.isActive }
    var isAltimeterActive: Bool { altimeterService.isActive }
    var isPedometerActive: Bool { pedometerService.isActive }
    var lastLocationTimestamp: Date? { runtimeState?.lastLocationTimestamp }
    var lastMotionTimestamp: Date? { runtimeState?.lastMotionTimestamp }
    var lastAltimeterTimestamp: Date? { runtimeState?.lastAltimeterTimestamp }
    var lastPedometerTimestamp: Date? { runtimeState?.lastPedometerTimestamp }

    init(repository: SensorDataRepository? = nil) {
        self.repository = repository ?? LocalSensorDataRepository()
        self.locationAuthorization = locationService.authorizationStatus
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
        sync.onServerSessionStarted = { [weak self] localSessionID, serverSessionID in
            guard var session = self?.activeSession, session.id == localSessionID else { return }
            session.serverSessionId = serverSessionID
            self?.activeSession = session
            self?.repository.update(session: session)
        }
        telemetrySync = sync
        pendingUploadCount = sync.pendingCount
    }

    func startSession(collectorId: String, motionRate: MotionSamplingRate, locationProfile: LocationCollectionProfile, distanceFilter: Double) {
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
            pausesLocationUpdatesAutomatically: false
        )
        let device = DeviceInfoProvider.current(capabilities: capabilities)
        let session = CollectionSession(
            id: UUID(),
            collectorId: collectorId.isEmpty ? "Unassigned" : collectorId,
            deviceId: device.deviceId,
            startedAt: Date(),
            endedAt: nil,
            status: .recording,
            serverSessionId: nil,
            deviceModel: device.deviceModel,
            systemVersion: device.systemVersion,
            sensorCapabilities: capabilities,
            sampleCounts: SampleCounts()
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
        telemetrySync?.start(session: session, device: device)

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
        refreshTimer?.invalidate()
        refreshTimer = nil
        publishUI()
        session.status = .completed
        session.endedAt = Date()
        session.sampleCounts = pendingCounts
        telemetrySync?.finish(
            session: session,
            lastSequences: LastSequencesPayload(
                location: locationSequence,
                motion: motionSequence,
                altimeter: altimeterSequence,
                pedometer: pedometerSequence
            )
        )
        print("[Diagnostics] LOCATION_STOPPED")
        print("[Diagnostics] MOTION_STOPPED")
        print("[Diagnostics] ALTIMETER_STOPPED")
        print("[Diagnostics] PEDOMETER_STOPPED")
        print("[Diagnostics] SESSION_FINISHED session=\(session.id.uuidString) lastSequences location=\(locationSequence) motion=\(motionSequence) altimeter=\(altimeterSequence) pedometer=\(pedometerSequence)")
        activeSession = nil
        runtimeState = nil
        diagnostics = nil
        interruptedCollection = nil
        activeCollectionStore.clear()
        repository.finish(session: session) { }
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

    func resumeInterruptedCollection() {
        guard var recovered = interruptedCollection, activeSession == nil else { return }
        recovered.diagnostics.wasInterrupted = true
        runtimeState = recovered
        capabilities = recovered.session.sensorCapabilities
        activeSession = recovered.session
        locationSequence = recovered.locationSequence
        motionSequence = recovered.motionSequence
        altimeterSequence = recovered.altimeterSequence
        pedometerSequence = recovered.pedometerSequence
        pendingCounts = recovered.session.sampleCounts
        uiCounts = pendingCounts
        interruptedCollection = nil

        repository.resume(session: recovered.session)
        let device = DeviceInfoProvider.current(capabilities: recovered.session.sensorCapabilities)
        telemetrySync?.start(session: recovered.session, device: device)
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

    func finishInterruptedCollection() {
        guard var recovered = interruptedCollection else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        recovered.session.status = .completed
        recovered.session.endedAt = Date()
        recovered.diagnostics.wasInterrupted = true
        repository.resume(session: recovered.session)
        repository.finish(session: recovered.session) { }
        activeCollectionStore.clear()
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
            runtime.diagnostics.lowPowerModeObserved = runtime.diagnostics.lowPowerModeObserved || ProcessInfo.processInfo.isLowPowerModeEnabled
            runtime.diagnostics.thermalStatePeak = max(runtime.diagnostics.thermalStatePeak, ProcessInfo.processInfo.thermalState.rawValue)
            runtimeState = runtime
            persistRuntime(immediately: state == .background)
        }
        appState = state
        appStateChangedAt = now

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
    }

    private func configureCallbacks() {
        locationService.onAuthorizationChanged = { [weak self] status in
            DispatchQueue.main.async {
                self?.locationAuthorization = status
                self?.logDiagnosticEvent("LOCATION_AUTHORIZATION_CHANGED", metadata: ["status": status.diagnosticLabel])
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
    }

    private func record(location: CLLocation) {
        guard let session = activeSession else { return }
        locationSequence += 1
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
        let measuredAt = bootTime.addingTimeInterval(motion.timestamp)
        let sample = MotionSample(id: UUID(), sessionId: session.id, sequence: motionSequence, timestamp: measuredAt, userAccelerationX: motion.userAcceleration.x, userAccelerationY: motion.userAcceleration.y, userAccelerationZ: motion.userAcceleration.z, rotationRateX: motion.rotationRate.x, rotationRateY: motion.rotationRate.y, rotationRateZ: motion.rotationRate.z, gravityX: motion.gravity.x, gravityY: motion.gravity.y, gravityZ: motion.gravity.z, attitudeRoll: motion.attitude.roll, attitudePitch: motion.attitude.pitch, attitudeYaw: motion.attitude.yaw, appState: appState, sensorSegmentId: motionSegmentId)
        updateRuntimeForMotion(timestamp: sample.timestamp)
        repository.append(motion: sample)
        telemetrySync?.append(motion: sample, session: session)
        pendingCounts.motion += 1
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    private func record(altitude: CMAltitudeData) {
        guard let session = activeSession else { return }
        altimeterSequence += 1
        let measuredAt = bootTime.addingTimeInterval(altitude.timestamp)
        let sample = AltimeterSample(id: UUID(), sessionId: session.id, sequence: altimeterSequence, timestamp: measuredAt, relativeAltitude: altitude.relativeAltitude.doubleValue, pressure: altitude.pressure.doubleValue, appState: appState, sensorSegmentId: altimeterSegmentId)
        updateRuntimeForAltimeter(timestamp: sample.timestamp)
        repository.append(altimeter: sample)
        telemetrySync?.append(altimeter: sample, session: session)
        pendingRelativeAltitude = sample.relativeAltitude
        pendingCounts.altimeter += 1
        telemetrySync?.update(sampleCounts: pendingCounts)
    }

    private func record(pedometer data: CMPedometerData, source: SensorCaptureSource = .live) {
        guard let session = activeSession else { return }
        pedometerSequence += 1
        let sample = PedometerSample(id: UUID(), sessionId: session.id, sequence: pedometerSequence, timestamp: data.endDate, captureSource: source, numberOfSteps: capabilities.stepCountingAvailable ? data.numberOfSteps.intValue : nil, distance: capabilities.distanceAvailable ? data.distance?.doubleValue : nil, currentPace: capabilities.paceAvailable ? data.currentPace?.doubleValue : nil, currentCadence: capabilities.cadenceAvailable ? data.currentCadence?.doubleValue : nil, floorsAscended: capabilities.floorCountingAvailable ? data.floorsAscended?.intValue : nil, floorsDescended: capabilities.floorCountingAvailable ? data.floorsDescended?.intValue : nil, appState: appState, sensorSegmentId: pedometerSegmentId)
        updateRuntimeForPedometer(timestamp: sample.timestamp)
        repository.append(pedometer: sample)
        telemetrySync?.append(pedometer: sample, session: session)
        pendingStepCount = sample.numberOfSteps
        pendingCounts.pedometer += 1
        telemetrySync?.update(sampleCounts: pendingCounts)
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
        telemetrySync?.logDiagnostic(eventType: type, metadata: metadata)
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
}

private struct SessionStartResponse: Decodable {
    let sessionId: String
}

nonisolated private struct AxisPayload: Codable {
    let x: Double?
    let y: Double?
    let z: Double?
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

nonisolated struct LastSequencesPayload: Codable {
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

    var id: String { clientSessionId }
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

nonisolated private struct UploadQueueState: Codable {
    var sessionStarts: [String: SessionStartPayload] = [:]
    var serverSessionIds: [String: String] = [:]
    var telemetry: [TelemetryBatchPayload] = []
    var markers: [MarkerPayload] = []
    var finishes: [FinishPayload] = []
    var diagnosticEvents: [QueuedDiagnosticEvent] = []

    init() {}

    // Manual Decodable so a queue file persisted before `diagnosticEvents` existed still
    // decodes (missing key -> empty array) instead of throwing and dropping every queued
    // upload that was waiting to sync.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionStarts = try container.decodeIfPresent([String: SessionStartPayload].self, forKey: .sessionStarts) ?? [:]
        serverSessionIds = try container.decodeIfPresent([String: String].self, forKey: .serverSessionIds) ?? [:]
        telemetry = try container.decodeIfPresent([TelemetryBatchPayload].self, forKey: .telemetry) ?? []
        markers = try container.decodeIfPresent([MarkerPayload].self, forKey: .markers) ?? []
        finishes = try container.decodeIfPresent([FinishPayload].self, forKey: .finishes) ?? []
        diagnosticEvents = try container.decodeIfPresent([QueuedDiagnosticEvent].self, forKey: .diagnosticEvents) ?? []
    }
}

private final class PersistentUploadQueue {
    private let url: URL
    private let encoder = TelemetrySyncCoordinator.makeEncoder()
    private let decoder = TelemetrySyncCoordinator.makeDecoder()
    private let storageQueue = DispatchQueue(label: "CampusTracker.upload-queue.storage", qos: .utility)
    private var pendingSave: DispatchWorkItem?
    var state: UploadQueueState

    init(fileManager: FileManager = .default) {
        let support = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? fileManager.temporaryDirectory
        let directory = support.appendingPathComponent("CampusCollector", isDirectory: true)
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

    var pendingCount: Int { state.telemetry.count + state.markers.count + state.finishes.count + state.diagnosticEvents.count }
}

@MainActor
final class TelemetrySyncCoordinator {
    var onPendingCountChanged: ((Int) -> Void)?
    var onServerSessionStarted: ((UUID, String) -> Void)?

    private let webSocket: RawWebSocketConnectionManager
    private let queue = PersistentUploadQueue()
    private var locations: [LocationPayload] = []
    private var motion: [MotionPayload] = []
    private var altimeter: [AltimeterPayload] = []
    private var pedometer: [PedometerPayload] = []
    private var activeSession: CollectionSession?
    private var batchTimer: Timer?
    private var statusTimer: Timer?
    private var sampleCounts = SampleCounts()
    private var awaiting = Set<String>()
    private var ackHandlers: [String: (Bool, Data?) -> Void] = [:]
    private let encodingQueue = DispatchQueue(label: "CampusTracker.websocket.encoding", qos: .userInitiated)

    var pendingCount: Int { queue.pendingCount }

    init(webSocket: RawWebSocketConnectionManager) {
        self.webSocket = webSocket
        webSocket.onConnected = { [weak self] in self?.handleConnected() }
        webSocket.onDisconnected = { [weak self] in self?.handleDisconnected() }
        webSocket.onTextMessage = { [weak self] in self?.handle(message: $0) }
        notifyCount()
    }

    func start(session: CollectionSession, device: DeviceInfo) {
        activeSession = session
        let payload = SessionStartPayload(
            clientSessionId: session.id.uuidString,
            deviceId: device.deviceId.uuidString,
            deviceModel: device.deviceModel,
            systemVersion: device.systemVersion,
            appVersion: device.appVersion,
            sensorCapabilities: session.sensorCapabilities,
            startedAt: session.startedAt
        )
        queue.state.sessionStarts[session.id.uuidString] = payload
        queue.save()
        startBatchTimer()
        startStatusTimer()
        synchronize()
    }

    func finish(session: CollectionSession, lastSequences: LastSequencesPayload) {
        flushBatch()
        batchTimer?.invalidate()
        batchTimer = nil
        statusTimer?.invalidate()
        statusTimer = nil
        let id = session.id.uuidString
        if !queue.state.finishes.contains(where: { $0.clientSessionId == id }) {
            queue.state.finishes.append(FinishPayload(clientSessionId: id, sessionId: queue.state.serverSessionIds[id], endedAt: session.endedAt ?? Date(), lastSequences: lastSequences))
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

    func update(sampleCounts: SampleCounts) {
        self.sampleCounts = sampleCounts
    }

    /// Local-first diagnostic events: not fusion input, used by the server only to explain gaps
    /// and restarts. Queued the same way as markers/finishes so they survive app restarts and
    /// disconnects, deduplicated server-side by `eventId`.
    func logDiagnostic(eventType: String, metadata: [String: String] = [:]) {
        guard let session = activeSession else { return }
        queue.state.diagnosticEvents.append(QueuedDiagnosticEvent(
            clientSessionId: session.id.uuidString,
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
        print("[UploadQueue] flush start state=\(webSocket.state.label) pending=\(queue.pendingCount) starts=\(queue.state.sessionStarts.count)")
        guard webSocket.state == .connected else {
            print("[UploadQueue] flush paused: WebSocket is not connected")
            return
        }
        sendMissingSessionStarts()
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
        let handlers = ackHandlers
        ackHandlers.removeAll()
        awaiting.removeAll()
        handlers.values.forEach { $0(false, nil) }
    }

    private func sendMissingSessionStarts() {
        guard let pair = queue.state.sessionStarts.first(where: { queue.state.serverSessionIds[$0.key] == nil }), !awaiting.contains("start-\(pair.key)") else {
            sendNextTelemetry()
            return
        }
        let key = pair.key
        awaiting.insert("start-\(key)")
        print("[UploadQueue] sending session:start clientSessionId=\(key)")
        send(type: "session:start", payload: pair.value, itemID: key) { [weak self] ok, data in
            guard let self = self else { return }
            self.awaiting.remove("start-\(key)")
            guard ok, let data = data,
                  let response = try? Self.makeDecoder().decode(SessionStartResponse.self, from: data) else {
                print("[UploadQueue] session:start ACK invalid or unsuccessful clientSessionId=\(key)")
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.synchronize() }
                return
            }
            self.queue.state.serverSessionIds[key] = response.sessionId
            self.queue.save()
            print("[UploadQueue] session:start ACK serverSessionId=\(response.sessionId)")
            if let uuid = UUID(uuidString: key) { self.onServerSessionStarted?(uuid, response.sessionId) }
            self.sendStatus()
            self.synchronize()
        }
    }

    private func sendNextTelemetry() {
        guard let index = queue.state.telemetry.firstIndex(where: { !awaiting.contains("batch-\($0.batchId)") }) else {
            sendNextMarker()
            return
        }
        var batch = queue.state.telemetry[index]
        guard let serverSessionId = batch.sessionId ?? queue.state.serverSessionIds[batch.clientSessionId] else {
            print("[UploadQueue] blocked telemetry:batch batchId=\(batch.batchId) clientSessionId=\(batch.clientSessionId): no persisted server sessionId; preserving oldest-first order")
            print("[UploadQueue] flush end pending=\(queue.pendingCount) blocked=batch")
            return
        }
        batch.sessionId = serverSessionId
        queue.state.telemetry[index] = batch
        queue.save()
        awaiting.insert("batch-\(batch.batchId)")
        print("[UploadQueue] sending telemetry:batch batchId=\(batch.batchId)")
        send(type: "telemetry:batch", payload: batch, itemID: batch.batchId) { [weak self] ok, _ in
            guard let self = self else { return }
            self.awaiting.remove("batch-\(batch.batchId)")
            if ok, let index = self.queue.state.telemetry.firstIndex(where: { $0.batchId == batch.batchId }) {
                self.queue.state.telemetry.remove(at: index)
                self.queue.save()
                self.notifyCount()
            }
            self.synchronize()
        }
    }

    private func sendNextMarker() {
        guard let index = queue.state.markers.firstIndex(where: { !awaiting.contains("marker-\($0.markerId)") }) else {
            sendNextFinish()
            return
        }
        var marker = queue.state.markers[index]
        guard let serverSessionId = marker.sessionId ?? queue.state.serverSessionIds[marker.clientSessionId] else {
            print("[UploadQueue] blocked marker:create markerId=\(marker.markerId) clientSessionId=\(marker.clientSessionId): no persisted server sessionId; preserving oldest-first order")
            print("[UploadQueue] flush end pending=\(queue.pendingCount) blocked=marker")
            return
        }
        marker.sessionId = serverSessionId
        queue.state.markers[index] = marker
        queue.save()
        awaiting.insert("marker-\(marker.markerId)")
        print("[UploadQueue] sending marker:create markerId=\(marker.markerId)")
        send(type: "marker:create", payload: marker, itemID: marker.markerId) { [weak self] ok, _ in
            guard let self = self else { return }
            self.awaiting.remove("marker-\(marker.markerId)")
            if ok, let index = self.queue.state.markers.firstIndex(where: { $0.markerId == marker.markerId }) {
                self.queue.state.markers.remove(at: index)
                self.queue.save()
                self.notifyCount()
            }
            self.synchronize()
        }
    }

    private func sendNextFinish() {
        guard let index = queue.state.finishes.firstIndex(where: { !awaiting.contains("finish-\($0.clientSessionId)") }) else {
            sendNextDiagnosticEvent()
            return
        }
        var finish = queue.state.finishes[index]
        guard let serverSessionId = finish.sessionId ?? queue.state.serverSessionIds[finish.clientSessionId] else {
            print("[UploadQueue] blocked session:finish clientSessionId=\(finish.clientSessionId): no persisted server sessionId")
            print("[UploadQueue] flush end pending=\(queue.pendingCount)")
            return
        }
        finish.sessionId = serverSessionId
        queue.state.finishes[index] = finish
        queue.save()
        awaiting.insert("finish-\(finish.clientSessionId)")
        print("[UploadQueue] sending session:finish clientSessionId=\(finish.clientSessionId)")
        send(type: "session:finish", payload: finish, itemID: finish.clientSessionId) { [weak self] ok, _ in
            guard let self = self else { return }
            self.awaiting.remove("finish-\(finish.clientSessionId)")
            if ok, let index = self.queue.state.finishes.firstIndex(where: { $0.clientSessionId == finish.clientSessionId }) {
                self.queue.state.finishes.remove(at: index)
                self.queue.state.sessionStarts.removeValue(forKey: finish.clientSessionId)
                self.queue.state.serverSessionIds.removeValue(forKey: finish.clientSessionId)
                self.queue.save()
                self.notifyCount()
            }
            self.synchronize()
        }
    }

    private func sendNextDiagnosticEvent() {
        guard let index = queue.state.diagnosticEvents.firstIndex(where: { !awaiting.contains("diagnostic-\($0.event.eventId)") }) else {
            print("[UploadQueue] flush end pending=\(queue.pendingCount)")
            return
        }
        let queued = queue.state.diagnosticEvents[index]
        awaiting.insert("diagnostic-\(queued.event.eventId)")
        print("[UploadQueue] sending diagnostic:event eventId=\(queued.event.eventId) type=\(queued.event.eventType)")
        let payload = DiagnosticEventPayload(clientSessionId: queued.clientSessionId, events: [queued.event])
        send(type: "diagnostic:event", payload: payload, itemID: queued.event.eventId) { [weak self] ok, _ in
            guard let self = self else { return }
            self.awaiting.remove("diagnostic-\(queued.event.eventId)")
            if ok, let index = self.queue.state.diagnosticEvents.firstIndex(where: { $0.event.eventId == queued.event.eventId }) {
                self.queue.state.diagnosticEvents.remove(at: index)
                self.queue.save()
                self.notifyCount()
            }
            self.synchronize()
        }
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
        send(type: "collector:status", payload: payload, itemID: serverSessionId) { _, _ in }
    }

    private func send<Payload: Encodable>(type: String, payload: Payload, itemID: String, completion: @escaping (Bool, Data?) -> Void) {
        let requestId = UUID().uuidString
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
                    completion(false, nil)

                case let .success(data):
                    guard let text = String(data: data, encoding: .utf8) else {
                        print("[WebSocket] UTF-8 conversion failed type=\(type) item=\(itemID)")
                        completion(false, nil)
                        return
                    }
                    print("[WebSocket] send type=\(type) requestId=\(requestId) item=\(itemID) bytes=\(data.count)")
                    self.ackHandlers[requestId] = completion
                    self.webSocket.send(text: text) { [weak self] error in
                        DispatchQueue.main.async {
                            guard let self = self else { return }
                            if let error = error {
                                print("[WebSocket] send completed type=\(type) requestId=\(requestId) error=\(error.localizedDescription)")
                                self.resolve(requestId: requestId, ok: false, data: nil)
                            } else {
                                print("[WebSocket] send completed type=\(type) requestId=\(requestId) error=nil")
                            }
                        }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                        self?.resolve(requestId: requestId, ok: false, data: nil)
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
        let responseData = object? ["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        let errorObject = object?["error"] as? [String: Any]
        let errorCode = (errorObject?["code"] as? String) ?? "—"
        let duplicate = (object?["duplicate"] as? Bool) ?? ((object?["data"] as? [String: Any])?["duplicate"] as? Bool) ?? false
        let retryable = errorObject?["retryable"] as? Bool
        print("[WebSocket] ACK requestId=\(ack.requestId) ok=\(ack.ok) duplicate=\(duplicate) errorCode=\(errorCode) retryable=\(retryable.map(String.init) ?? "—")")
        resolve(requestId: ack.requestId, ok: ack.ok, data: responseData)
    }

    private func resolve(requestId: String, ok: Bool, data: Data?) {
        guard let handler = ackHandlers.removeValue(forKey: requestId) else { return }
        handler(ok, data)
    }

    private func notifyCount() { onPendingCountChanged?(queue.pendingCount) }

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
