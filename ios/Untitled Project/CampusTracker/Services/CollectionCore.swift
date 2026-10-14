import Foundation

// MARK: - Requests, results, events

nonisolated struct SensorRunClocks: Sendable {
    let motion: TrackingClockAnchor
    let altimeter: TrackingClockAnchor
    let absoluteAltitude: TrackingClockAnchor
    let arkit: TrackingClockAnchor

    init(motion: TrackingClockAnchor, altimeter: TrackingClockAnchor, arkit: TrackingClockAnchor) {
        self.init(motion: motion, altimeter: altimeter, absoluteAltitude: altimeter, arkit: arkit)
    }

    init(motion: TrackingClockAnchor, altimeter: TrackingClockAnchor,
         absoluteAltitude: TrackingClockAnchor, arkit: TrackingClockAnchor) {
        self.motion = motion
        self.altimeter = altimeter
        self.absoluteAltitude = absoluteAltitude
        self.arkit = arkit
    }
}

nonisolated struct CollectionCoreConfiguration: Sendable {
    var leaseBlockSize = 200
    /// Unsaved tail policy: commit 250 ms after the first uncommitted sample or at 32 samples.
    /// A process/OS kill before that commit loses the tail; this is not lossless capture.
    var commitInterval: TimeInterval = 0.25
    var commitCount = 32
    var batchInterval: TimeInterval = 1
    var batchCount = 64
    var snapshotInterval: TimeInterval = 0.2
    /// Initial ARKit backpressure thresholds (pause / allow manual resume). To be tuned after
    /// throughput experiments; the single-ACK upload path cannot drain 10–20 poses/s indefinitely.
    var arkitPauseCount = 6_000
    var arkitPauseAgeSeconds: TimeInterval = 120
    var arkitResumeCount = 3_000
    var arkitResumeAgeSeconds: TimeInterval = 30
    var clockUncertainThresholdSeconds: TimeInterval = 2
}

nonisolated struct SessionBeginRequest: Sendable {
    let snapshot: ActiveCollectionState
    let owner: UploadOwner
    let startPayload: Data
    let clocks: SensorRunClocks
    let streams: Set<CaptureStream>
    let walkingFrame: WalkingFrameEstimatorConfiguration?
    let deviceID: UUID
}

nonisolated struct SessionResumeRequest: Sendable {
    let sessionID: UUID
    let clocks: SensorRunClocks
    let streams: Set<CaptureStream>
    let walkingFrame: WalkingFrameEstimatorConfiguration?
    let deviceID: UUID
}

nonisolated struct CaptureRunInfo: Sendable {
    let snapshot: ActiveCollectionState
    let contexts: [CaptureStream: TrackingCaptureContext]
    /// Items created while opening the run (e.g. batches for raw a crashed process committed but
    /// never batched).
    let committedItems: [UploadItemRecord]
}

nonisolated struct StopResult: Sendable {
    let sessionID: UUID
    let intent: StopIntent
    let manifest: LastSequencesPayload
    let snapshot: ActiveCollectionState
    let items: [UploadItemRecord]
}

nonisolated struct CoreSnapshot: Sendable {
    let sessionID: UUID
    let acceptedCounts: SampleCounts
    let durableCounts: SampleCounts
    let pendingCommitCount: Int
    let latestLocation: LocationSample?
    let latestRelativeAltitude: Double?
    let latestStepCount: Int?
    let arkitPoseCount: Int
    let arkitLastPoseAt: Date?
    let walkingFrame: WalkingFrameSnapshot?
    let magneticQuality: MagneticCalibrationQuality?
    let state: ActiveCollectionState
    let lastCommitAt: Date?
}

nonisolated enum CollectionCoreEvent: Sendable {
    case snapshot(CoreSnapshot)
    case uploadItemsCommitted([UploadItemRecord])
    case storageFailure(sessionID: UUID, code: String, message: String)
    case diagnostic(sessionID: UUID, type: String, metadata: [String: String])
    case arkitBackpressurePaused(sessionID: UUID, backlog: Int, oldestAgeSeconds: Double)
}

nonisolated enum CollectionCoreError: Error, Equatable, CustomStringConvertible {
    case runAlreadyActive
    case noActiveRun
    case notResumable(String)
    case storage(code: String, message: String)
    case arkitBacklogTooHigh(count: Int, oldestAgeSeconds: Double)

    var description: String {
        switch self {
        case .runAlreadyActive: return "CAPTURE_RUN_ALREADY_ACTIVE"
        case .noActiveRun: return "NO_ACTIVE_CAPTURE_RUN"
        case let .notResumable(reason): return "SESSION_NOT_RESUMABLE: \(reason)"
        case let .storage(code, message): return "\(code): \(message)"
        case let .arkitBacklogTooHigh(count, age): return "ARKIT_BACKLOG_TOO_HIGH count=\(count) oldestAge=\(Int(age))s"
        }
    }
}

typealias CoreCompletion<T: Sendable> = @MainActor @Sendable (Result<T, Error>) -> Void

nonisolated extension SampleCounts {
    mutating func increment(_ stream: String, by amount: Int = 1) {
        switch stream {
        case "location": location += amount
        case "motion": motion += amount
        case "altimeter": altimeter += amount
        case "absoluteAltitude": absoluteAltitude += amount
        case "pedometer": pedometer += amount
        case "marker": marker += amount
        default: break
        }
    }
}

// MARK: - Core

/// Owns everything between a sensor callback and a durable SQLite commit: admission, clock
/// mapping, sequence issue (lease-reserved before use), walking-frame estimation, the pending
/// commit buffer, telemetry batching and the Stop drain/finalization barrier.
///
/// `@unchecked Sendable`: all mutable state is confined to `queue` (checked with
/// `dispatchPrecondition`). Public entry points only submit DTOs/commands. Storage is reached
/// with `store.sync` from `queue` (never the reverse direction), and the main thread never
/// waits on `queue`.
nonisolated final class CollectionCore: @unchecked Sendable {
    let queue = DispatchQueue(label: "CampusCollector.collection-core", qos: .userInitiated)
    let store: CollectionStore
    let configuration: CollectionCoreConfiguration
    private let ingresses: [CaptureStream: TrackingCaptureIngress]
    private let lateDrops = CaptureDropCounter()
    private var eventHandler: (@Sendable (CollectionCoreEvent) -> Void)?
    private var run: ActiveRun?
    private let encoder = TrackingJSONCodec.makeEncoder()
    private let decoder = TrackingJSONCodec.makeDecoder()

    init(store: CollectionStore, configuration: CollectionCoreConfiguration = .init()) {
        self.store = store
        self.configuration = configuration
        var ingresses: [CaptureStream: TrackingCaptureIngress] = [:]
        for stream in CaptureStream.allCases { ingresses[stream] = TrackingCaptureIngress(processorQueue: queue) }
        self.ingresses = ingresses
    }

    func setEventHandler(_ handler: @escaping @Sendable (CollectionCoreEvent) -> Void) {
        queue.async { self.eventHandler = handler }
    }

    private func emit(_ event: CollectionCoreEvent) {
        dispatchPrecondition(condition: .onQueue(queue))
        eventHandler?(event)
    }

    private func complete<T: Sendable>(_ completion: @escaping CoreCompletion<T>, _ result: Result<T, Error>) {
        DispatchQueue.main.async { completion(result) }
    }

    /// Test/diagnostic barrier: returns after every previously submitted admission and command.
    func waitUntilIdleForTesting() { queue.sync {} }

    // MARK: Admission (any thread)

    /// Called directly from sensor callback threads. `context` is the constant captured when the
    /// sensor was started; a closed or previous-generation context is rejected and only counted.
    func submit(_ sample: CapturedSample, context: TrackingCaptureContext) {
        let stream = sample.payload.stream
        guard let ingress = ingresses[stream] else { return }
        let accepted = ingress.submit(context: context) { [weak self] admission in
            self?.process(sample, admission: admission)
        }
        if !accepted { lateDrops.increment(stream.rawValue) }
    }

    // MARK: Lifecycle

    func beginSession(_ request: SessionBeginRequest, completion: @escaping CoreCompletion<CaptureRunInfo>) {
        queue.async {
            guard self.run == nil else { return self.complete(completion, .failure(CollectionCoreError.runAlreadyActive)) }
            do {
                // session snapshot + session:start ledger data in one COMMIT before any sensor runs.
                try self.store.sync {
                    try $0.createSession(snapshot: request.snapshot, owner: request.owner, startPayload: request.startPayload,
                                         streams: CaptureStream.allCases.map(\.rawValue) + ["marker"])
                }
                let run = ActiveRun(snapshot: request.snapshot, clocks: request.clocks, deviceID: request.deviceID,
                                    walkingFrame: request.walkingFrame)
                let info = try self.open(run, streams: request.streams, committedItems: [])
                self.complete(completion, .success(info))
            } catch {
                self.complete(completion, .failure(error))
            }
        }
    }

    func resumeSession(_ request: SessionResumeRequest, completion: @escaping CoreCompletion<CaptureRunInfo>) {
        queue.async {
            guard self.run == nil else { return self.complete(completion, .failure(CollectionCoreError.runAlreadyActive)) }
            do {
                guard let stored = try self.store.sync({ try $0.session(id: request.sessionID) }) else {
                    throw CollectionStoreError.sessionNotFound(request.sessionID.uuidString)
                }
                guard stored.captureState == .recording, stored.stopIntent == nil, var snapshot = stored.snapshot else {
                    throw CollectionCoreError.notResumable("state=\(stored.captureState.rawValue) stopIntent=\(stored.stopIntent != nil)")
                }
                let leases = try self.store.sync { try $0.leases(sessionID: request.sessionID) }
                let pedometer = try self.store.sync { try $0.rawPayloads(sessionID: request.sessionID, stream: "pedometer") }
                snapshot.diagnostics.wasInterrupted = true
                snapshot.session.status = .recording
                let run = ActiveRun(snapshot: snapshot, clocks: request.clocks, deviceID: request.deviceID,
                                    walkingFrame: request.walkingFrame)
                // Recovery rule: never reuse a sequence any earlier process could have issued.
                let snapshotSequences = ["location": snapshot.locationSequence, "motion": snapshot.motionSequence,
                                         "altimeter": snapshot.altimeterSequence,
                                         "absoluteAltitude": snapshot.absoluteAltitudeSequence ?? 0,
                                         "pedometer": snapshot.pedometerSequence]
                run.durable = SampleCounts()
                for (stream, lease) in leases {
                    let lastIssued = max(snapshotSequences[stream] ?? 0, lease.lastRecorded, lease.reservedExclusive - 1, 0)
                    run.allocators[stream] = StreamAllocator(lastIssued: lastIssued, reservedExclusive: lease.reservedExclusive)
                    run.durable.increment(stream, by: lease.recordedCount)
                }
                run.accepted = run.durable
                run.snapshot.session.sampleCounts = run.durable
                for (key, payload) in pedometer {
                    if let sample = try? RawSampleDecoding.decode(PedometerSample.self, from: payload) {
                        run.pedometerValues[key] = PedometerValueKey(sample)
                    }
                }
                try self.store.sync { try $0.updateSnapshot(run.snapshot) }
                let leftovers = try self.createBatches(run, minimum: 1)
                let info = try self.open(run, streams: request.streams, committedItems: leftovers)
                self.complete(completion, .success(info))
            } catch {
                self.complete(completion, .failure(error))
            }
        }
    }

    private func open(_ run: ActiveRun, streams: Set<CaptureStream>,
                      committedItems: [UploadItemRecord]) throws -> CaptureRunInfo {
        dispatchPrecondition(condition: .onQueue(queue))
        for ingress in ingresses.values { ingress.closeIfOpen { _ in } }
        lateDrops.reset()
        var contexts: [CaptureStream: TrackingCaptureContext] = [:]
        for stream in streams {
            let context = TrackingCaptureContext(sessionID: run.sessionID, streamSegmentID: UUID(), generation: UUID())
            try ingresses[stream]?.open(context)
            contexts[stream] = context
        }
        run.contexts = contexts
        self.run = run
        startTimers(run)
        return CaptureRunInfo(snapshot: run.snapshot, contexts: contexts, committedItems: committedItems)
    }

    // MARK: Host commands

    func addMarker(_ marker: EventMarker) {
        queue.async {
            guard let run = self.run, run.phase == .recording, marker.sessionId == run.sessionID else { return }
            do {
                let sequence = try self.issue(run, stream: "marker")
                let draft = UploadItemDraft(kind: .marker, itemID: marker.id.uuidString,
                                            payload: try self.encoder.encode(MarkerPayload(marker: marker)))
                run.pending.append(RawRecordDraft(stream: "marker", sequence: sequence,
                                                  measuredAtMs: epochMilliseconds(marker.timestamp),
                                                  payload: try self.encoder.encode(marker), uploadItem: draft))
                run.accepted.marker += 1
                self.commitPending(run)
            } catch {
                self.enterStorageFailure(run, code: "MARKER_CAPTURE_FAILED", error: error)
            }
        }
    }

    /// App-state and power diagnostics owned by the MainActor, merged into the durable snapshot
    /// on the next commit.
    func updateHostDiagnostics(_ update: @escaping @Sendable (inout CollectionDiagnostics) -> Void) {
        queue.async {
            guard let run = self.run else { return }
            update(&run.snapshot.diagnostics)
            run.snapshotDirty = true
        }
    }

    /// Background transition: commit the tail and batch immediately.
    func flushNow() {
        queue.async {
            guard let run = self.run, run.phase == .recording else { return }
            guard self.commitPending(run, force: true) else { return }
            do { _ = try self.createBatches(run, minimum: 1) }
            catch { self.enterStorageFailure(run, code: "BATCH_COMMIT_FAILED", error: error) }
        }
    }

    // MARK: Stop

    /// Stop step 2–5. The admission boundary is taken synchronously on the caller's thread: every
    /// ingress is closed here, each enqueueing its drain barrier, and the finalize block is
    /// enqueued after all of them. Callbacks arriving after this line are counted as late, never
    /// attributed to this (or a later) session.
    func beginStop(reason: String, completion: @escaping CoreCompletion<StopResult>) {
        for ingress in ingresses.values {
            ingress.closeIfOpen { [weak self] boundary in self?.recordBoundary(boundary) }
        }
        queue.async { self.finalizeActiveRun(reason: reason, completion: completion) }
    }

    private func recordBoundary(_ boundary: TrackingStopBoundary) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let run, run.sessionID == boundary.context.sessionID else { return }
        run.boundaries.append(boundary)
    }

    private func finalizeActiveRun(reason: String, completion: @escaping CoreCompletion<StopResult>) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let run else { return complete(completion, .failure(CollectionCoreError.noActiveRun)) }
        run.phase = .stopping
        run.commitTimer?.cancel()
        run.commitTimer = nil
        mergeLateDrops(into: run)
        if run.stopIntent == nil {
            let intent = StopIntent(sessionID: run.sessionID, endedAt: stopCutoff(run), reason: reason,
                                    interrupted: false, requestedAt: Date())
            run.applyStopIntent(intent)
            do {
                try store.sync { try $0.persistStopIntent(intent, snapshot: run.snapshot) }
                run.stopIntent = intent
            } catch {
                run.phase = .storageFailure
                emit(.storageFailure(sessionID: run.sessionID, code: "STOP_INTENT_PERSISTENCE_FAILED", message: String(describing: error)))
                return complete(completion, .failure(CollectionCoreError.storage(code: "STOP_INTENT_PERSISTENCE_FAILED", message: String(describing: error))))
            }
        }
        guard commitPending(run, force: true) else {
            run.phase = .storageFailure
            return complete(completion, .failure(CollectionCoreError.storage(code: "STOP_RAW_COMMIT_FAILED", message: run.storageError ?? "")))
        }
        do {
            let batches = try createBatches(run, minimum: 1)
            guard let intent = run.stopIntent else { throw CollectionCoreError.noActiveRun }
            let result = try finalize(sessionID: run.sessionID, snapshot: run.snapshot, intent: intent, extraItems: batches)
            run.snapshot = result.snapshot
            emitSnapshot(run)
            stopTimers(run)
            run.phase = .stopped
            self.run = nil
            complete(completion, .success(result))
        } catch {
            run.phase = .storageFailure
            run.storageError = String(describing: error)
            emit(.storageFailure(sessionID: run.sessionID, code: "STOP_FINALIZATION_FAILED", message: String(describing: error)))
            complete(completion, .failure(CollectionCoreError.storage(code: "STOP_FINALIZATION_FAILED", message: String(describing: error))))
        }
    }

    /// Closes a session this process is not running (interrupted / stop requested before a
    /// crash). Uses the durable rows only: the crashed process's uncommitted tail is gone.
    func finishRecovered(sessionID: UUID, completion: @escaping CoreCompletion<StopResult>) {
        queue.async {
            if self.run?.sessionID == sessionID {
                return self.complete(completion, .failure(CollectionCoreError.runAlreadyActive))
            }
            do {
                guard let stored = try self.store.sync({ try $0.session(id: sessionID) }), var snapshot = stored.snapshot else {
                    throw CollectionStoreError.sessionNotFound(sessionID.uuidString)
                }
                let leases = try self.store.sync { try $0.leases(sessionID: sessionID) }
                var durable = SampleCounts()
                for (stream, lease) in leases { durable.increment(stream, by: lease.recordedCount) }
                snapshot.session.sampleCounts = durable
                let intent: StopIntent
                if let existing = stored.stopIntent {
                    intent = existing
                } else {
                    guard stored.captureState == .recording else {
                        throw CollectionCoreError.notResumable("state=\(stored.captureState.rawValue)")
                    }
                    // The last moment this device is known to have recorded, not "now".
                    let endedAt = [snapshot.lastLocationTimestamp, snapshot.lastMotionTimestamp,
                                   snapshot.lastAltimeterTimestamp, snapshot.lastPedometerTimestamp]
                        .compactMap { $0 }.max() ?? snapshot.lastPersistedAt
                    intent = StopIntent(sessionID: sessionID, endedAt: endedAt, reason: "interrupted_finish",
                                        interrupted: true, requestedAt: Date())
                    snapshot.diagnostics.wasInterrupted = true
                    snapshot.apply(intent)
                    try self.store.sync { try $0.persistStopIntent(intent, snapshot: snapshot) }
                }
                let batches = try self.store.sync { access in
                    try access.createTelemetryBatches(sessionID: sessionID, maximumSamples: self.configuration.batchCount,
                                                      minimumSamples: 1) { batchID, rows in
                        try self.encodeBatch(batchID: batchID, sessionID: sessionID, rows: rows)
                    }
                }
                let result = try self.finalize(sessionID: sessionID, snapshot: snapshot, intent: intent, extraItems: batches)
                self.complete(completion, .success(result))
            } catch {
                self.complete(completion, .failure(error))
            }
        }
    }

    /// Stop step 6: one transaction — stopped + final manifest from what was actually preserved
    /// + `session:finish` with the fixed endedAt + final snapshot.
    private func finalize(sessionID: UUID, snapshot: ActiveCollectionState, intent: StopIntent,
                          extraItems: [UploadItemRecord]) throws -> StopResult {
        dispatchPrecondition(condition: .onQueue(queue))
        let manifest = try store.sync { try $0.manifest(sessionID: sessionID) }
        var final = snapshot
        final.apply(intent)
        final.pendingStop = PendingStopState(endedAt: intent.endedAt, reason: intent.reason,
                                             locationSequence: manifest.location, motionSequence: manifest.motion,
                                             altimeterSequence: manifest.altimeter, pedometerSequence: manifest.pedometer,
                                             absoluteAltitudeSequence: manifest.absoluteAltitude)
        let finish = FinishPayload(clientSessionId: sessionID.uuidString, sessionId: nil, endedAt: intent.endedAt,
                                   lastSequences: manifest, interrupted: intent.interrupted)
        let draft = UploadItemDraft(kind: .finish, itemID: sessionID.uuidString, payload: try encoder.encode(finish))
        let finishItem = try store.sync { try $0.finalize(sessionID: sessionID, manifest: manifest, finish: draft, snapshot: final) }
        return StopResult(sessionID: sessionID, intent: intent, manifest: manifest, snapshot: final, items: extraItems + [finishItem])
    }

    private func stopCutoff(_ run: ActiveRun) -> Date {
        // endedAt = the latest stream admission cutoff on the common uptime clock, converted once.
        guard let cutoff = run.boundaries.map(\.cutoffUptime).max(), let anchor = run.clocks?.motion else { return Date() }
        return anchor.epochAtAnchor.addingTimeInterval(cutoff - anchor.uptimeAtAnchor)
    }

    // MARK: ARKit backpressure

    /// Re-opens the ARKit stream after a backpressure pause, only once the backlog has drained
    /// below the resume thresholds. The caller must start ARKit fresh (new arSessionId).
    func reopenArkit(completion: @escaping CoreCompletion<TrackingCaptureContext>) {
        queue.async {
            guard let run = self.run, run.phase == .recording else {
                return self.complete(completion, .failure(CollectionCoreError.noActiveRun))
            }
            do {
                let backlog = try self.store.sync { try $0.pendingItemBacklog(sessionID: run.sessionID, kind: .arkit) }
                let age = backlog.oldestCreatedAtMs.map { Double(epochMilliseconds(Date()) - $0) / 1_000 } ?? 0
                guard backlog.count < self.configuration.arkitResumeCount, age < self.configuration.arkitResumeAgeSeconds else {
                    throw CollectionCoreError.arkitBacklogTooHigh(count: backlog.count, oldestAgeSeconds: age)
                }
                let context = TrackingCaptureContext(sessionID: run.sessionID, streamSegmentID: UUID(), generation: UUID())
                try self.ingresses[.arkit]?.open(context)
                run.contexts[.arkit] = context
                run.arkitPaused = false
                self.complete(completion, .success(context))
            } catch {
                self.complete(completion, .failure(error))
            }
        }
    }

    private func checkArkitBackpressure(_ run: ActiveRun) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !run.arkitPaused, run.contexts[.arkit] != nil else { return }
        guard let backlog = try? store.sync({ try $0.pendingItemBacklog(sessionID: run.sessionID, kind: .arkit) }) else { return }
        let age = backlog.oldestCreatedAtMs.map { Double(epochMilliseconds(Date()) - $0) / 1_000 } ?? 0
        guard backlog.count >= configuration.arkitPauseCount || age >= configuration.arkitPauseAgeSeconds else { return }
        // Pause capture instead of discarding stored poses; telemetry keeps running.
        ingresses[.arkit]?.closeIfOpen { _ in }
        run.contexts[.arkit] = nil
        run.arkitPaused = true
        run.snapshot.diagnostics.arkitBackpressurePauses = (run.snapshot.diagnostics.arkitBackpressurePauses ?? 0) + 1
        run.snapshotDirty = true
        emit(.arkitBackpressurePaused(sessionID: run.sessionID, backlog: backlog.count, oldestAgeSeconds: age))
    }

    // MARK: Processing (queue)

    private func process(_ captured: CapturedSample, admission: TrackingAdmission) {
        dispatchPrecondition(condition: .onQueue(queue))
        let stream = captured.payload.stream
        guard let run, run.contexts[stream] == admission.context,
              run.phase == .recording || run.phase == .stopping else {
            lateDrops.increment(stream.rawValue)
            return
        }
        let context = admission.context
        do {
            switch captured.payload {
            case let .location(value): try processLocation(value, captured: captured, context: context, run: run)
            case let .motion(value): try processMotion(value, captured: captured, context: context, run: run)
            case let .altimeter(value): try processAltimeter(value, captured: captured, context: context, run: run)
            case let .absoluteAltitude(value): try processAbsoluteAltitude(value, captured: captured, context: context, run: run)
            case let .pedometer(value): try processPedometer(value, captured: captured, context: context, run: run)
            case let .arkit(value): try processArkit(value, captured: captured, context: context, run: run)
            }
        } catch let CollectionCoreError.storage(code, message) {
            enterStorageFailure(run, code: code, error: CollectionCoreError.storage(code: code, message: message))
            return
        } catch {
            enterStorageFailure(run, code: "CAPTURE_ENCODING_FAILED", error: error)
            return
        }
        scheduleCommit(run)
    }

    private func metadata(_ captured: CapturedSample, context: TrackingCaptureContext, native: Double?,
                          systemTime: Date?, clock: TrackingClockAnchor?, stream: CaptureStream,
                          run: ActiveRun) -> CaptureMetadata {
        var value = CaptureMetadata(sessionID: context.sessionID, segmentID: context.streamSegmentID,
                                    generation: context.generation, nativeTimestamp: native,
                                    measuredEpochFromSystem: systemTime, callbackUptime: captured.callbackUptime,
                                    callbackEpoch: captured.callbackEpoch, appStateAtCapture: captured.appState)
        if let clock {
            value.clockMappingVersion = clock.mappingVersion
            value.clockDomain = "BOOT_UPTIME"
            value.clockQuality = run.clockQuality[stream] ?? "nominal"
            value.verifiedOffsetSeconds = clock.verifiedOffsetSeconds
        }
        return value
    }

    /// Records delivery residual and native dt. A residual >= threshold on the first sample is
    /// flagged `CLOCK_MAPPING_UNCERTAIN`; the mapping/offset is NOT changed.
    private func observeClock(stream: CaptureStream, native: Double, measuredAt: Date, captured: CapturedSample,
                              clock: TrackingClockAnchor, run: ActiveRun) {
        var diagnostics = run.snapshot.diagnostics.clock?[stream.rawValue] ?? ClockStreamDiagnostics(
            domain: "BOOT_UPTIME", quality: "nominal", mappingVersion: clock.mappingVersion,
            verifiedOffsetSeconds: clock.verifiedOffsetSeconds)
        let residual = captured.callbackEpoch.timeIntervalSince(measuredAt)
        if diagnostics.firstResidualSeconds == nil {
            diagnostics.firstResidualSeconds = residual
            if abs(residual) >= configuration.clockUncertainThresholdSeconds {
                diagnostics.quality = "uncertain"
                run.clockQuality[stream] = "uncertain"
                emit(.diagnostic(sessionID: run.sessionID, type: "CLOCK_MAPPING_UNCERTAIN", metadata: [
                    "sensor": stream.rawValue, "residualSeconds": String(format: "%.3f", residual),
                    "mappingVersion": String(clock.mappingVersion)]))
            }
        }
        diagnostics.samples += 1
        diagnostics.residualSumSeconds += residual
        diagnostics.maximumAbsoluteResidualSeconds = max(diagnostics.maximumAbsoluteResidualSeconds, abs(residual))
        if let previous = run.lastNative[stream] {
            let gap = native - previous
            if gap <= 0 { diagnostics.nonIncreasingNativeTimestamps += 1 }
            diagnostics.maximumNativeGapSeconds = max(diagnostics.maximumNativeGapSeconds, gap)
        }
        run.lastNative[stream] = native
        var all = run.snapshot.diagnostics.clock ?? [:]
        all[stream.rawValue] = diagnostics
        run.snapshot.diagnostics.clock = all
    }

    private func rejectInvalid(_ stream: CaptureStream, run: ActiveRun) {
        var drops = run.snapshot.diagnostics.invalidSampleDrops ?? [:]
        drops[stream.rawValue, default: 0] += 1
        run.snapshot.diagnostics.invalidSampleDrops = drops
        if drops[stream.rawValue] == 1 {
            emit(.diagnostic(sessionID: run.sessionID, type: "INVALID_SAMPLE_REJECTED", metadata: ["sensor": stream.rawValue]))
        }
    }

    private func processLocation(_ value: LocationCapture, captured: CapturedSample,
                                 context: TrackingCaptureContext, run: ActiveRun) throws {
        guard value.latitude.isFinite, value.longitude.isFinite, (-90...90).contains(value.latitude),
              (-180...180).contains(value.longitude), value.timestamp.timeIntervalSince1970.isFinite else {
            return rejectInvalid(.location, run: run)
        }
        let sequence = try issue(run, stream: "location")
        let sample = LocationSample(id: UUID(), sessionId: run.sessionID, sequence: sequence, timestamp: value.timestamp,
            latitude: value.latitude, longitude: value.longitude, altitude: value.altitude,
            ellipsoidalAltitude: value.ellipsoidalAltitude, horizontalAccuracy: value.horizontalAccuracy,
            verticalAccuracy: value.verticalAccuracy, speed: value.speed, course: value.course,
            speedAccuracy: value.speedAccuracy, courseAccuracy: value.courseAccuracy, floor: value.floor,
            appState: captured.appState, sensorSegmentId: context.streamSegmentID.uuidString)
        let envelope = RawSampleEnvelope(capture: metadata(captured, context: context, native: nil,
            systemTime: value.timestamp, clock: nil, stream: .location, run: run), sample: sample)
        try append(run, stream: "location", sequence: sequence, measuredAt: value.timestamp, payload: encoder.encode(envelope))
        run.snapshot.diagnostics.locationGaps.record(previous: run.snapshot.lastLocationTimestamp, current: value.timestamp, expectedInterval: 1)
        run.snapshot.lastLocationTimestamp = value.timestamp
        run.snapshot.locationSequence = sequence
        run.latestLocation = sample
    }

    private func processMotion(_ value: MotionCapture, captured: CapturedSample,
                               context: TrackingCaptureContext, run: ActiveRun) throws {
        let vectors = [value.userAcceleration, value.rotationRate, value.gravity]
        guard vectors.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }),
              value.nativeTimestamp.isFinite, value.nativeTimestamp >= 0, let clock = run.clocks?.motion,
              let measuredAt = try? clock.map(nativeTimestamp: value.nativeTimestamp) else {
            return rejectInvalid(.motion, run: run)
        }
        observeClock(stream: .motion, native: value.nativeTimestamp, measuredAt: measuredAt, captured: captured, clock: clock, run: run)
        let sequence = try issue(run, stream: "motion")
        // The estimator runs here, on the same serial executor as the raw sample it belongs to.
        var walkingFrame: WalkingFrameSnapshot?
        if run.walkingEstimator != nil {
            let input = WalkingFrameInput(sensorTimestamp: value.nativeTimestamp, userAcceleration: value.userAcceleration,
                gravity: value.gravity, rotationRate: value.rotationRate, attitudeQuaternion: value.quaternion,
                magneticField: value.magneticField, sensorSegmentId: context.streamSegmentID.uuidString)
            if var snapshot = run.walkingEstimator?.process(input) {
                snapshot.estimatedAt = try? clock.mapDerived(nativeTimestamp: snapshot.estimatedAtSensorTimestamp, owningNativeTimestamp: value.nativeTimestamp, owningMeasuredAt: measuredAt)
                snapshot.windowStart = try? clock.mapDerived(nativeTimestamp: snapshot.windowStartSensorTimestamp, owningNativeTimestamp: value.nativeTimestamp, owningMeasuredAt: measuredAt)
                snapshot.windowEnd = try? clock.mapDerived(nativeTimestamp: snapshot.windowEndSensorTimestamp, owningNativeTimestamp: value.nativeTimestamp, owningMeasuredAt: measuredAt)
                snapshot.expiresAt = try? clock.mapDerived(nativeTimestamp: snapshot.expiresAtSensorTimestamp, owningNativeTimestamp: value.nativeTimestamp, owningMeasuredAt: measuredAt)
                walkingFrame = snapshot
                observeWalkingFrame(snapshot, run: run)
            }
        }
        if let magnetic = value.magneticField, magnetic.accuracy != run.magneticQuality {
            run.magneticQuality = magnetic.accuracy
            emit(.diagnostic(sessionID: run.sessionID, type: "MAGNETIC_CALIBRATION_CHANGED", metadata: [
                "accuracy": magnetic.accuracy.rawValue, "magnitudeUT": String(format: "%.1f", magnetic.magnitude),
                "source": CalibratedMagneticFieldSample.source]))
        }
        let sample = MotionSample(id: UUID(), sessionId: run.sessionID, sequence: sequence, timestamp: measuredAt,
            userAccelerationX: value.userAcceleration.x, userAccelerationY: value.userAcceleration.y, userAccelerationZ: value.userAcceleration.z,
            rotationRateX: value.rotationRate.x, rotationRateY: value.rotationRate.y, rotationRateZ: value.rotationRate.z,
            gravityX: value.gravity.x, gravityY: value.gravity.y, gravityZ: value.gravity.z,
            attitudeRoll: value.roll, attitudePitch: value.pitch, attitudeYaw: value.yaw,
            attitudeQuaternion: value.quaternion, magneticField: value.magneticField, walkingFrame: walkingFrame,
            appState: captured.appState, sensorSegmentId: context.streamSegmentID.uuidString)
        let envelope = RawSampleEnvelope(capture: metadata(captured, context: context, native: value.nativeTimestamp,
            systemTime: nil, clock: clock, stream: .motion, run: run), sample: sample)
        try append(run, stream: "motion", sequence: sequence, measuredAt: measuredAt, payload: encoder.encode(envelope))
        run.snapshot.diagnostics.motionGaps.record(previous: run.snapshot.lastMotionTimestamp, current: measuredAt,
                                                   expectedInterval: run.snapshot.motionRate.interval)
        run.snapshot.lastMotionTimestamp = measuredAt
        run.snapshot.motionSequence = sequence
    }

    private func observeWalkingFrame(_ snapshot: WalkingFrameSnapshot, run: ActiveRun) {
        run.walkingFrame = snapshot
        if snapshot.frameId != run.lastWalkingFrameID {
            run.lastWalkingFrameID = snapshot.frameId
            emit(.diagnostic(sessionID: run.sessionID, type: "WALKING_FRAME_INITIALIZED", metadata: [
                "frameId": snapshot.frameId.uuidString, "algorithmVersion": snapshot.algorithmVersion]))
        }
        if snapshot.status != run.lastWalkingStatus {
            run.lastWalkingStatus = snapshot.status
            emit(.diagnostic(sessionID: run.sessionID, type: "WALKING_FRAME_STATUS_CHANGED", metadata: [
                "status": snapshot.status.rawValue, "frameId": snapshot.frameId.uuidString,
                "confidence": String(format: "%.3f", snapshot.confidence),
                "directionResolved": String(snapshot.directionResolved)]))
        }
    }

    private func processAltimeter(_ value: AltimeterCapture, captured: CapturedSample,
                                  context: TrackingCaptureContext, run: ActiveRun) throws {
        guard value.relativeAltitude.isFinite, value.pressure.isFinite, let clock = run.clocks?.altimeter,
              let measuredAt = try? clock.map(nativeTimestamp: value.nativeTimestamp) else {
            return rejectInvalid(.altimeter, run: run)
        }
        observeClock(stream: .altimeter, native: value.nativeTimestamp, measuredAt: measuredAt, captured: captured, clock: clock, run: run)
        let sequence = try issue(run, stream: "altimeter")
        let sample = AltimeterSample(id: UUID(), sessionId: run.sessionID, sequence: sequence, timestamp: measuredAt,
            relativeAltitude: value.relativeAltitude, pressure: value.pressure, appState: captured.appState,
            sensorSegmentId: context.streamSegmentID.uuidString)
        let envelope = RawSampleEnvelope(capture: metadata(captured, context: context, native: value.nativeTimestamp,
            systemTime: nil, clock: clock, stream: .altimeter, run: run), sample: sample)
        try append(run, stream: "altimeter", sequence: sequence, measuredAt: measuredAt, payload: encoder.encode(envelope))
        run.snapshot.diagnostics.altimeterGaps.record(previous: run.snapshot.lastAltimeterTimestamp, current: measuredAt, expectedInterval: 1)
        run.snapshot.lastAltimeterTimestamp = measuredAt
        run.snapshot.altimeterSequence = sequence
        run.latestRelativeAltitude = value.relativeAltitude
    }

    private func processAbsoluteAltitude(_ value: AbsoluteAltitudeCapture, captured: CapturedSample,
                                         context: TrackingCaptureContext, run: ActiveRun) throws {
        guard value.nativeTimestamp.isFinite, value.nativeTimestamp >= 0,
              let clock = run.clocks?.absoluteAltitude,
              let measuredAt = try? clock.map(nativeTimestamp: value.nativeTimestamp) else {
            return rejectInvalid(.absoluteAltitude, run: run)
        }
        observeClock(stream: .absoluteAltitude, native: value.nativeTimestamp, measuredAt: measuredAt,
                     captured: captured, clock: clock, run: run)
        let sequence = try issue(run, stream: CaptureStream.absoluteAltitude.rawValue)
        let altitude = value.altitude.finiteOrNil
        let accuracy = value.accuracy.finiteOrNil
        let precision = value.precision.finiteOrNil
        let invalidReason: String? = altitude == nil ? "NON_FINITE_ALTITUDE" :
            (accuracy == nil ? "NON_FINITE_ACCURACY" : (precision == nil ? "NON_FINITE_PRECISION" : nil))
        let sample = AbsoluteAltitudeSample(
            id: UUID(), sessionId: run.sessionID, sequence: sequence, timestamp: measuredAt,
            altitude: altitude, accuracy: accuracy, precision: precision, verticalReference: "APPLE_MSL",
            sensorSegmentId: context.streamSegmentID.uuidString, captureSource: .live,
            appState: captured.appState, invalidReason: invalidReason)
        let envelope = RawSampleEnvelope(capture: metadata(captured, context: context, native: value.nativeTimestamp,
            systemTime: nil, clock: clock, stream: .absoluteAltitude, run: run), sample: sample)
        try append(run, stream: CaptureStream.absoluteAltitude.rawValue, sequence: sequence,
                   measuredAt: measuredAt, payload: encoder.encode(envelope))
        var gaps = run.snapshot.diagnostics.absoluteAltitudeGaps ?? SensorGapSummary()
        gaps.record(previous: run.snapshot.lastAbsoluteAltitudeTimestamp, current: measuredAt, expectedInterval: 1)
        run.snapshot.diagnostics.absoluteAltitudeGaps = gaps
        run.snapshot.lastAbsoluteAltitudeTimestamp = measuredAt
        run.snapshot.absoluteAltitudeSequence = sequence
    }

    private func processPedometer(_ value: PedometerCapture, captured: CapturedSample,
                                  context: TrackingCaptureContext, run: ActiveRun) throws {
        guard value.endDate.timeIntervalSince1970.isFinite else { return rejectInvalid(.pedometer, run: run) }
        // Server dedupe key is (session, millisecond timestamp): check BEFORE issuing a sequence,
        // otherwise the manifest max would advance for a sample the server drops.
        let key = epochMilliseconds(value.endDate)
        let candidateValue = PedometerValueKey(value)
        if let existing = run.pedometerValues[key] {
            if existing == candidateValue {
                run.snapshot.diagnostics.pedometerDuplicateDrops = (run.snapshot.diagnostics.pedometerDuplicateDrops ?? 0) + 1
            } else {
                run.snapshot.diagnostics.pedometerDuplicateConflicts = (run.snapshot.diagnostics.pedometerDuplicateConflicts ?? 0) + 1
                let audit = try? encoder.encode(PedometerSample(id: UUID(), sessionId: run.sessionID, sequence: -1,
                    timestamp: value.endDate, captureSource: value.source, numberOfSteps: value.numberOfSteps,
                    distance: value.distance, currentPace: value.currentPace, currentCadence: value.currentCadence,
                    floorsAscended: value.floorsAscended, floorsDescended: value.floorsDescended,
                    appState: captured.appState, sensorSegmentId: context.streamSegmentID.uuidString))
                try? store.sync { try $0.insertAudit(sessionID: run.sessionID, stream: "pedometer", reason: "PEDOMETER_DUPLICATE_CONFLICT", measuredAtMs: key, payload: audit) }
                emit(.diagnostic(sessionID: run.sessionID, type: "PEDOMETER_DUPLICATE_CONFLICT", metadata: [
                    "timestampMs": String(key), "source": value.source.rawValue]))
            }
            run.snapshotDirty = true
            return
        }
        let sequence = try issue(run, stream: "pedometer")
        let sample = PedometerSample(id: UUID(), sessionId: run.sessionID, sequence: sequence, timestamp: value.endDate,
            captureSource: value.source, numberOfSteps: value.numberOfSteps, distance: value.distance,
            currentPace: value.currentPace, currentCadence: value.currentCadence, floorsAscended: value.floorsAscended,
            floorsDescended: value.floorsDescended, appState: captured.appState,
            sensorSegmentId: context.streamSegmentID.uuidString)
        let envelope = RawSampleEnvelope(capture: metadata(captured, context: context, native: nil,
            systemTime: value.endDate, clock: nil, stream: .pedometer, run: run), sample: sample)
        try append(run, stream: "pedometer", sequence: sequence, measuredAt: value.endDate, payload: encoder.encode(envelope))
        run.pedometerValues[key] = candidateValue
        run.snapshot.diagnostics.pedometerGaps.record(previous: run.snapshot.lastPedometerTimestamp, current: value.endDate, expectedInterval: 5)
        run.snapshot.lastPedometerTimestamp = value.endDate
        run.snapshot.pedometerSequence = sequence
        run.latestStepCount = value.numberOfSteps
    }

    private func processArkit(_ pose: ARKitPoseSample, captured: CapturedSample,
                              context: TrackingCaptureContext, run: ActiveRun) throws {
        let values = [pose.positionX, pose.positionY, pose.positionZ, pose.rotationX, pose.rotationY, pose.rotationZ, pose.rotationW]
        guard values.allSatisfy(\.isFinite), let clock = run.clocks?.arkit,
              let measuredAt = try? clock.map(nativeTimestamp: pose.frameTimestamp) else {
            return rejectInvalid(.arkit, run: run)
        }
        observeClock(stream: .arkit, native: pose.frameTimestamp, measuredAt: measuredAt, captured: captured, clock: clock, run: run)
        let sequence = try issue(run, stream: "arkit")
        let wire = ArkitPoseWire(sessionId: "", arSessionId: pose.arSessionId.uuidString, deviceId: run.deviceID.uuidString,
            sequence: pose.sequence, timestamp: epochMilliseconds(measuredAt), frameTimestamp: pose.frameTimestamp,
            position: Vector3Payload(x: pose.positionX, y: pose.positionY, z: pose.positionZ),
            rotation: QuaternionPayload(x: pose.rotationX, y: pose.rotationY, z: pose.rotationZ, w: pose.rotationW),
            trackingState: pose.trackingState.rawValue)
        let envelope = RawSampleEnvelope(capture: metadata(captured, context: context, native: pose.frameTimestamp,
            systemTime: nil, clock: clock, stream: .arkit, run: run), sample: ARKitRawRecord(pose: pose, measuredAt: measuredAt))
        let draft = UploadItemDraft(kind: .arkit, itemID: wire.itemID, payload: try encoder.encode(wire))
        run.pending.append(RawRecordDraft(stream: "arkit", sequence: sequence, measuredAtMs: epochMilliseconds(measuredAt),
                                          payload: try encoder.encode(envelope), uploadItem: draft))
        run.arkitPoseCount += 1
        run.arkitLastPoseAt = measuredAt
    }

    private func append(_ run: ActiveRun, stream: String, sequence: Int, measuredAt: Date, payload: Data) throws {
        run.pending.append(RawRecordDraft(stream: stream, sequence: sequence, measuredAtMs: epochMilliseconds(measuredAt),
                                          payload: payload, uploadItem: nil))
        run.accepted.increment(stream)
    }

    /// Issues the next sequence. When the candidate reaches the reserved boundary, the next block
    /// is reserved durably FIRST; on failure nothing advances and the error propagates.
    private func issue(_ run: ActiveRun, stream: String) throws -> Int {
        var allocator = run.allocators[stream] ?? StreamAllocator(lastIssued: 0, reservedExclusive: 0)
        let candidate = allocator.lastIssued + 1
        if candidate >= allocator.reservedExclusive {
            let limit = candidate + configuration.leaseBlockSize
            do {
                try store.sync { try $0.reserveLease(sessionID: run.sessionID, stream: stream, reservedExclusive: limit) }
            } catch {
                throw CollectionCoreError.storage(code: "SEQUENCE_LEASE_RESERVATION_FAILED", message: String(describing: error))
            }
            allocator.reservedExclusive = limit
        }
        allocator.lastIssued = candidate
        run.allocators[stream] = allocator
        return candidate
    }

    // MARK: Commit / batch

    private func scheduleCommit(_ run: ActiveRun) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard run.phase == .recording else { return }
        if run.pending.count >= configuration.commitCount {
            commitPending(run)
            return
        }
        // Deadline is fixed by the FIRST uncommitted sample; later samples never push it back.
        guard run.commitTimer == nil, !run.pending.isEmpty else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + configuration.commitInterval)
        timer.setEventHandler { [weak self, weak run] in
            guard let self, let run else { return }
            run.commitTimer?.cancel()
            run.commitTimer = nil
            if run.phase == .recording { self.commitPending(run) }
        }
        run.commitTimer = timer
        timer.resume()
    }

    /// Commits the pending buffer (raw rows + linked ARKit/marker items + counters + snapshot) in
    /// one transaction. The buffer and its already-issued sequences are cleared ONLY after COMMIT;
    /// a failure keeps them for a retry with the same sequences and enters storageFailure.
    @discardableResult
    private func commitPending(_ run: ActiveRun, force: Bool = false) -> Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        run.commitTimer?.cancel()
        run.commitTimer = nil
        guard !run.pending.isEmpty || run.snapshotDirty || force else { return true }
        let records = run.pending
        var durable = run.durable
        for record in records { durable.increment(record.stream) }
        var snapshot = run.snapshot
        snapshot.session.sampleCounts = durable
        snapshot.lastPersistedAt = Date()
        do {
            let items = try store.sync { try $0.commitRaw(sessionID: run.sessionID, records: records, snapshot: snapshot) }
            run.pending.removeFirst(records.count)
            run.durable = durable
            run.snapshot.session.sampleCounts = durable
            run.snapshot.lastPersistedAt = snapshot.lastPersistedAt
            run.lastCommitAt = snapshot.lastPersistedAt
            run.snapshotDirty = false
            run.unbatched += records.filter { $0.uploadItem == nil }.count
            if !items.isEmpty { emit(.uploadItemsCommitted(items)) }
            if run.phase == .recording, run.unbatched >= configuration.batchCount {
                _ = try createBatches(run, minimum: configuration.batchCount)
            }
            if records.contains(where: { $0.stream == "arkit" }) { checkArkitBackpressure(run) }
            return true
        } catch {
            enterStorageFailure(run, code: "RAW_COMMIT_FAILED", error: error)
            return false
        }
    }

    private func encodeBatch(batchID: String, sessionID: UUID, rows: [RawRow]) throws -> Data {
        try encoder.encode(RawSampleDecoding.telemetryBatch(batchID: batchID, clientSessionID: sessionID.uuidString,
                                                            rows: rows, createdAt: Date()))
    }

    private func createBatches(_ run: ActiveRun, minimum: Int) throws -> [UploadItemRecord] {
        dispatchPrecondition(condition: .onQueue(queue))
        let sessionID = run.sessionID
        let (items, remaining) = try store.sync { access -> ([UploadItemRecord], Int) in
            let items = try access.createTelemetryBatches(sessionID: sessionID, maximumSamples: configuration.batchCount,
                                                          minimumSamples: minimum) { batchID, rows in
                try self.encodeBatch(batchID: batchID, sessionID: sessionID, rows: rows)
            }
            return (items, try access.unbatchedTelemetryCount(sessionID: sessionID))
        }
        run.unbatched = remaining
        if !items.isEmpty { emit(.uploadItemsCommitted(items)) }
        return items
    }

    private func enterStorageFailure(_ run: ActiveRun, code: String, error: Error) {
        dispatchPrecondition(condition: .onQueue(queue))
        let message = String(describing: error)
        guard run.phase != .storageFailure else { return }
        run.phase = .storageFailure
        run.storageError = "\(code): \(message)"
        run.commitTimer?.cancel()
        run.commitTimer = nil
        // Close admission; keep the pending buffer and issued sequences for the Stop retry.
        for ingress in ingresses.values { ingress.closeIfOpen { _ in } }
        print("[CollectionCore] \(code) session=\(run.sessionID.uuidString) error=\(message)")
        emit(.storageFailure(sessionID: run.sessionID, code: code, message: message))
    }

    private func mergeLateDrops(into run: ActiveRun) {
        let drops = lateDrops.snapshot()
        guard !drops.isEmpty else { return }
        run.snapshot.diagnostics.lateCallbackDrops = drops
        run.snapshotDirty = true
    }

    // MARK: Timers / UI snapshot

    private func startTimers(_ run: ActiveRun) {
        let batch = DispatchSource.makeTimerSource(queue: queue)
        batch.schedule(deadline: .now() + configuration.batchInterval, repeating: configuration.batchInterval)
        batch.setEventHandler { [weak self, weak run] in
            guard let self, let run, run.phase == .recording else { return }
            do { _ = try self.createBatches(run, minimum: 1) }
            catch { self.enterStorageFailure(run, code: "BATCH_COMMIT_FAILED", error: error) }
        }
        run.batchTimer = batch
        batch.resume()
        let snapshot = DispatchSource.makeTimerSource(queue: queue)
        snapshot.schedule(deadline: .now() + configuration.snapshotInterval, repeating: configuration.snapshotInterval)
        snapshot.setEventHandler { [weak self, weak run] in
            guard let self, let run else { return }
            self.emitSnapshot(run)
        }
        run.snapshotTimer = snapshot
        snapshot.resume()
    }

    private func stopTimers(_ run: ActiveRun) {
        run.commitTimer?.cancel(); run.commitTimer = nil
        run.batchTimer?.cancel(); run.batchTimer = nil
        run.snapshotTimer?.cancel(); run.snapshotTimer = nil
    }

    private func emitSnapshot(_ run: ActiveRun) {
        emit(.snapshot(CoreSnapshot(sessionID: run.sessionID, acceptedCounts: run.accepted, durableCounts: run.durable,
            pendingCommitCount: run.pending.count, latestLocation: run.latestLocation,
            latestRelativeAltitude: run.latestRelativeAltitude, latestStepCount: run.latestStepCount,
            arkitPoseCount: run.arkitPoseCount, arkitLastPoseAt: run.arkitLastPoseAt, walkingFrame: run.walkingFrame,
            magneticQuality: run.magneticQuality, state: run.snapshot, lastCommitAt: run.lastCommitAt)))
    }
}

// MARK: - Run state (confined to CollectionCore.queue)

nonisolated struct StreamAllocator: Sendable, Equatable {
    var lastIssued: Int
    var reservedExclusive: Int
}

nonisolated struct PedometerValueKey: Equatable, Sendable {
    let steps: Int?
    let distance: Double?
    let floorsAscended: Int?
    let floorsDescended: Int?

    init(_ capture: PedometerCapture) {
        steps = capture.numberOfSteps; distance = capture.distance
        floorsAscended = capture.floorsAscended; floorsDescended = capture.floorsDescended
    }

    init(_ sample: PedometerSample) {
        steps = sample.numberOfSteps; distance = sample.distance
        floorsAscended = sample.floorsAscended; floorsDescended = sample.floorsDescended
    }
}

nonisolated enum RunPhase: Sendable { case recording, stopping, storageFailure, stopped }

nonisolated private final class ActiveRun {
    var snapshot: ActiveCollectionState
    var phase: RunPhase = .recording
    let clocks: SensorRunClocks?
    let deviceID: UUID
    var contexts: [CaptureStream: TrackingCaptureContext] = [:]
    var allocators: [String: StreamAllocator] = [:]
    var pending: [RawRecordDraft] = []
    var accepted = SampleCounts()
    var durable = SampleCounts()
    var unbatched = 0
    var snapshotDirty = false
    var walkingEstimator: WalkingFrameEstimator?
    var walkingFrame: WalkingFrameSnapshot?
    var lastWalkingFrameID: UUID?
    var lastWalkingStatus: WalkingFrameStatus?
    var magneticQuality: MagneticCalibrationQuality?
    var latestLocation: LocationSample?
    var latestRelativeAltitude: Double?
    var latestStepCount: Int?
    var arkitPoseCount = 0
    var arkitLastPoseAt: Date?
    var arkitPaused = false
    var pedometerValues: [Int64: PedometerValueKey] = [:]
    var clockQuality: [CaptureStream: String] = [:]
    var lastNative: [CaptureStream: Double] = [:]
    var boundaries: [TrackingStopBoundary] = []
    var stopIntent: StopIntent?
    var storageError: String?
    var lastCommitAt: Date?
    var commitTimer: DispatchSourceTimer?
    var batchTimer: DispatchSourceTimer?
    var snapshotTimer: DispatchSourceTimer?

    var sessionID: UUID { snapshot.session.id }

    init(snapshot: ActiveCollectionState, clocks: SensorRunClocks?, deviceID: UUID,
         walkingFrame: WalkingFrameEstimatorConfiguration?) {
        self.snapshot = snapshot
        self.clocks = clocks
        self.deviceID = deviceID
        self.walkingEstimator = walkingFrame.map(WalkingFrameEstimator.init(configuration:))
        self.durable = snapshot.session.sampleCounts
        self.accepted = snapshot.session.sampleCounts
    }

    func applyStopIntent(_ intent: StopIntent) {
        snapshot.apply(intent)
        snapshotDirty = true
    }

    deinit {
        commitTimer?.cancel(); batchTimer?.cancel(); snapshotTimer?.cancel()
    }
}

nonisolated extension ActiveCollectionState {
    mutating func apply(_ intent: StopIntent) {
        session.status = .completed
        session.endedAt = intent.endedAt
        pendingStop = PendingStopState(endedAt: intent.endedAt, reason: intent.reason,
                                       locationSequence: locationSequence, motionSequence: motionSequence,
                                       altimeterSequence: altimeterSequence, pedometerSequence: pedometerSequence,
                                       absoluteAltitudeSequence: absoluteAltitudeSequence)
    }
}
