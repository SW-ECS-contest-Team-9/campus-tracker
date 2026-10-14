import Foundation

/// Fair turn-taking between ledger item classes. Pure value type so the policy is testable
/// without a socket.
///
/// - At most `telemetryBurst` consecutive telemetry batches, then one eligible marker/diagnostic,
///   then one eligible ARKit pose before the next telemetry batch.
/// - Independently, an eligible pose gets a turn when the last ARKit send is older than
///   `arkitMaxWaitSeconds`.
/// - `finish` is lowest priority; the engine only offers it once its own session is drained.
///
/// This only improves fairness. A single in-flight request cannot drain 10–20 poses/s in
/// general; sustained backlog is handled by ARKit capture backpressure, not by dropping poses.
nonisolated struct UploadScheduler: Sendable, Equatable {
    enum Lane: Sendable, Hashable { case telemetry, aux, arkit, finish }

    static let telemetryBurst = 4
    static let arkitMaxWaitSeconds: TimeInterval = 1

    private(set) var telemetryStreak = 0
    private(set) var owesArkitTurn = false
    private(set) var lastArkitDispatchUptime: TimeInterval?

    func choose(available: Set<Lane>, now: TimeInterval) -> Lane? {
        if available.contains(.arkit) {
            let waited = lastArkitDispatchUptime.map { now - $0 >= Self.arkitMaxWaitSeconds } ?? true
            if owesArkitTurn || waited { return .arkit }
        }
        if telemetryStreak >= Self.telemetryBurst {
            if available.contains(.aux) { return .aux }
            if available.contains(.arkit) { return .arkit }
        }
        for lane in [Lane.telemetry, .aux, .arkit, .finish] where available.contains(lane) { return lane }
        return nil
    }

    mutating func record(_ lane: Lane, now: TimeInterval) {
        switch lane {
        case .telemetry:
            telemetryStreak += 1
        case .aux:
            telemetryStreak = 0
            owesArkitTurn = true
        case .arkit:
            telemetryStreak = 0
            owesArkitTurn = false
            lastArkitDispatchUptime = now
        case .finish:
            telemetryStreak = 0
        }
    }
}

/// Uploads the durable SQLite ledger over the collector WebSocket, one request in flight.
///
/// State machine per request: idle → encoding(ticket) → awaitingAck(ticket) → committingAck →
/// idle. Every completion (encode, send, ACK, timeout) carries the ticket and is ignored unless it
/// still matches the in-flight ticket, the connection generation and the owner. A valid ACK's
/// local ledger COMMIT blocks the next pump (`storageMutationPending`) and may finish even if the
/// connection drops meanwhile; an unconfirmed/stale ACK never completes another ticket.
@MainActor
final class TelemetryUploadEngine {
    var onPendingCountChanged: ((Int) -> Void)?
    var onQuarantinedCountChanged: ((Int) -> Void)?
    var onHeldCountChanged: ((Int) -> Void)?
    var onUnsynchronizedCountChanged: ((Int) -> Void)?
    var onServerSessionStarted: ((UUID, String) -> Void)?
    /// The latest session:start ACK lists `absoluteAltitudeV1`: new batches may carry that stream.
    var onAbsoluteAltitudeSupported: ((UUID) -> Void)?
    var onStorageError: ((String) -> Void)?

    static let sessionRestartCodes: Set<String> = ["SESSION_NOT_FOUND", "SESSION_NOT_STARTED"]
    static let ackTimeoutSeconds: TimeInterval = 10
    static let retryDelaySeconds: TimeInterval = 2
    static let statusIntervalSeconds: TimeInterval = 7

    let store: CollectionStore
    private let webSocket: CollectorSocket
    private let encodingQueue = DispatchQueue(label: "CampusTracker.websocket.encoding", qos: .userInitiated)

    private(set) var isLoaded = false
    private(set) var loadFailure: String?
    private var sessions: [String: SessionSyncRecord] = [:]
    /// PENDING / QUARANTINED / HELD items in enqueue order. ACKED items are dropped from memory.
    private var items: [UploadItemRecord] = []
    private var owner: UploadOwner?
    private var activeSessionID: String?
    private var statusTimer: Timer?
    private var sampleCounts = SampleCounts()
    private var sessionsWithHeldAbsoluteAltitude: Set<String> = []
    private var absoluteAltitudeSupportedSessions: Set<String> = []
    private var connectionGeneration: UInt64 = 0
    private var scheduler = UploadScheduler()
    private var preferFinishingLane = true
    private var storageMutationPending = false
    private var retryNotBeforeUptime: TimeInterval?
    private var retryWake: DispatchWorkItem?

    private enum Target: Equatable {
        case start(String)
        case item(UploadItemKey, sessionID: String)
        case syncComplete(String)
    }

    private struct Ticket: Equatable {
        let requestId: String
        let target: Target
        let owner: UploadOwner
        let connectionGeneration: UInt64
    }

    private enum Resolution {
        case ack(ok: Bool, error: AckError?, data: Data?)
        case timeout
        case transportFailed(String)
        case encodingFailed(String)
    }

    private struct InFlight {
        let ticket: Ticket
        var timeout: DispatchWorkItem?
        let completion: (Resolution) -> Void
    }

    private var inFlight: InFlight?

    init(webSocket: CollectorSocket, store: CollectionStore) {
        self.webSocket = webSocket
        self.store = store
        webSocket.onConnected = { [weak self] in self?.handleConnected() }
        webSocket.onDisconnected = { [weak self] in self?.handleDisconnected() }
        webSocket.onTextMessage = { [weak self] in self?.handle(message: $0) }
        reload()
    }

    /// Test/standalone convenience: a private store rooted at `queueDirectory`.
    convenience init(webSocket: CollectorSocket, queueDirectory: URL) {
        self.init(webSocket: webSocket, store: CollectionStore(directory: queueDirectory))
    }

    /// Initial ledger load runs on the store queue; nothing is sent until it completes.
    private func reload() {
        store.async({ access in
            // Batches an earlier build quarantined for its absolute-altitude clock are rebuilt and
            // queued again before the ledger loads. A failed repair leaves them quarantined.
            do {
                let requeued = try access.repairAbsoluteAltitudeClock { batchID, sessionID, rows in
                    let payload = try RawSampleDecoding.telemetryBatch(batchID: batchID, clientSessionID: sessionID,
                                                                       rows: rows, createdAt: Date())
                    return try TrackingJSONCodec.makeEncoder().encode(payload)
                }
                if !requeued.isEmpty { print("[UploadEngine] absolute-altitude clock repair requeued=\(requeued.count)") }
            } catch {
                print("[UploadEngine] absolute-altitude clock repair failed error=\(error)")
            }
            try access.requireFeatureRehandshakeForHeldAbsoluteAltitude()
            return (try access.loadUploadLedger(), try access.sessionsWithHeldAbsoluteAltitude())
        }) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success((snapshot, heldSessions)):
                self.sessionsWithHeldAbsoluteAltitude = heldSessions
                for session in snapshot.sessions { self.sessions[session.sessionID] = session }
                self.merge(snapshot.items)
                self.isLoaded = true
            case let .failure(error):
                self.loadFailure = String(describing: error)
                self.onStorageError?("UPLOAD_LEDGER_LOAD_FAILED: \(error)")
                print("[UploadEngine] ledger load failed error=\(error)")
            }
            self.notifyCount()
            self.synchronize()
        }
    }

    // MARK: Public API

    func updateOwner(_ newOwner: UploadOwner?) {
        if newOwner != owner, let current = inFlight {
            // Invalidate: the item stays PENDING and is re-sent under its own owner later.
            current.timeout?.cancel()
            inFlight = nil
        }
        owner = newOwner
        if newOwner != nil {
            // A fresh login retries any session:start this process previously gave up on.
            for key in sessions.keys where sessions[key]?.startQuarantined == true { sessions[key]?.startQuarantined = false }
            store.async({ try $0.setStartQuarantined(false, sessionID: nil) }) { _ in }
        }
        notifyCount()
        synchronize()
    }

    /// Marks the live capture session (reconnect re-handshake + periodic collector status).
    func activate(sessionID: UUID) {
        activeSessionID = sessionID.uuidString
        // After a process restart the feature decision is gone with the old process: ask again,
        // otherwise a resumed session keeps every absolute-altitude row local until it finishes.
        if !absoluteAltitudeSupportedSessions.contains(sessionID.uuidString), requireHandshake(sessionID.uuidString) { synchronize() }
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(withTimeInterval: Self.statusIntervalSeconds, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sendStatus() }
        }
    }

    func deactivate(sessionID: UUID) {
        guard activeSessionID == sessionID.uuidString else { return }
        activeSessionID = nil
        statusTimer?.invalidate()
        statusTimer = nil
    }

    /// Picks up a session row written by `CollectionCore` (start payload + owner).
    func registerSession(id: UUID, completion: (@MainActor @Sendable () -> Void)? = nil) {
        let key = id.uuidString
        store.async({ try $0.sessionSync(id: key) }) { [weak self] result in
            guard let self else { return }
            if case let .success(record?) = result {
                if let existing = self.sessions[key] {
                    var merged = record
                    merged.serverSessionID = existing.serverSessionID ?? record.serverSessionID
                    self.sessions[key] = merged
                } else {
                    self.sessions[key] = record
                }
            } else if case let .failure(error) = result {
                self.onStorageError?("UPLOAD_SESSION_LOAD_FAILED: \(error)")
            }
            self.notifyCount()
            self.synchronize()
            completion?()
        }
    }

    /// Commit notification from `CollectionCore`: items are already durable in SQLite.
    func ingest(_ committed: [UploadItemRecord]) {
        merge(committed)
        notifyCount()
        let finishingSessions = Set(committed.filter { $0.kind == .finish }.map(\.sessionID))
        guard !finishingSessions.isEmpty else { return synchronize() }
        store.async({ access in
            Set(try finishingSessions.filter { try access.heldAbsoluteAltitudeCount(sessionID: $0) > 0 })
        }) { [weak self] result in
            guard let self else { return }
            if case let .success(held) = result {
                self.sessionsWithHeldAbsoluteAltitude.formUnion(held)
                for sessionID in held where self.absoluteAltitudeSupportedSessions.contains(sessionID) {
                    self.releaseAbsoluteAltitude(sessionID: sessionID)
                }
            }
            self.synchronize()
        }
    }

    func update(sampleCounts: SampleCounts) {
        self.sampleCounts = sampleCounts
    }

    /// Local-first diagnostic events: not fusion input, used by the server only to explain gaps
    /// and restarts. Durable in the ledger before they are eligible to send.
    func logDiagnostic(eventType: String, metadata: [String: String] = [:], clientSessionId: String) {
        guard let draft = Self.diagnosticDraft(eventType: eventType, metadata: metadata) else { return }
        store.async({ try $0.insertUploadItem(sessionID: clientSessionId, draft: draft) }) { [weak self] result in
            switch result {
            case let .success(record): self?.ingest([record])
            case let .failure(error):
                print("[UploadEngine] diagnostic not stored type=\(eventType) error=\(error)")
            }
        }
    }

    private static func diagnosticDraft(eventType: String, metadata: [String: String]) -> UploadItemDraft? {
        let event = DiagnosticEventItem(eventId: UUID().uuidString, eventType: eventType, clientTimestamp: Date(), metadata: metadata)
        guard let payload = try? TrackingJSONCodec.makeEncoder().encode(event) else { return nil }
        return UploadItemDraft(kind: .diagnostic, itemID: event.eventId, payload: payload)
    }

    func arkitBacklog(sessionID: UUID) -> (count: Int, oldestAgeSeconds: Double) {
        let id = sessionID.uuidString
        let poses = items.filter { $0.sessionID == id && $0.kind == .arkit && $0.state == .pending }
        let oldest = poses.map(\.createdAtMs).min()
        let age = oldest.map { Double(epochMilliseconds(Date()) - $0) / 1_000 } ?? 0
        return (poses.count, age)
    }

    // MARK: Counts

    var pendingCount: Int { countSummary.sendable }
    var heldCount: Int { countSummary.held }
    var quarantinedCount: Int {
        items.filter { $0.state == .quarantined }.count
            + sessions.values.filter { $0.syncState == .quarantined || $0.syncState == .protocolError }.count
    }
    var unsynchronizedCount: Int { sessions.values.filter { $0.syncState == .incomplete }.count }

    private func awaitingSyncComplete(_ session: SessionSyncRecord) -> Bool {
        session.syncState == .finishAcknowledged && session.finishAck != nil
    }

    private var countSummary: (sendable: Int, held: Int) {
        var sendable = 0
        var held = 0
        for item in items where item.state == .pending || item.state == .heldOrphaned {
            if item.state == .pending, let owner, sessions[item.sessionID]?.owner == owner { sendable += 1 } else { held += 1 }
        }
        for session in sessions.values where awaitingSyncComplete(session) {
            if let owner, session.owner == owner { sendable += 1 } else { held += 1 }
        }
        return (sendable, held)
    }

    private func notifyCount() {
        let summary = countSummary
        onPendingCountChanged?(summary.sendable)
        onQuarantinedCountChanged?(quarantinedCount)
        onHeldCountChanged?(summary.held)
        onUnsynchronizedCountChanged?(unsynchronizedCount)
    }

    // MARK: Memory model

    private func merge(_ incoming: [UploadItemRecord]) {
        guard !incoming.isEmpty else { return }
        let known = Set(items.map(\.key))
        let fresh = incoming.filter { $0.state != .acked && !known.contains($0.key) }
        guard !fresh.isEmpty else { return }
        if let last = items.last, let first = fresh.map(\.enqueueOrder).min(), first < last.enqueueOrder {
            items.append(contentsOf: fresh)
            items.sort { $0.enqueueOrder < $1.enqueueOrder }
        } else {
            items.append(contentsOf: fresh.sorted { $0.enqueueOrder < $1.enqueueOrder })
        }
    }

    private func removeItem(_ key: UploadItemKey) {
        items.removeAll { $0.key == key }
    }

    private func updateItem(_ key: UploadItemKey, _ change: (inout UploadItemRecord) -> Void) {
        guard let index = items.firstIndex(where: { $0.key == key }) else { return }
        change(&items[index])
    }

    private func dropCompletedSessions() {
        let busy = Set(items.map(\.sessionID))
        for (id, session) in sessions where session.syncState == .complete && !busy.contains(id) && id != activeSessionID {
            sessions.removeValue(forKey: id)
            print("[UploadEngine] completed session released clientSessionId=\(id)")
        }
    }

    // MARK: Pump

    func synchronize() {
        guard isLoaded, inFlight == nil, !storageMutationPending else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let notBefore = retryNotBeforeUptime {
            // Monotonic backoff: flushes, commits and diagnostics cannot bypass the retry window.
            guard now >= notBefore else { scheduleWake(at: notBefore); return }
            retryNotBeforeUptime = nil
        }
        dropCompletedSessions()
        guard webSocket.state == .connected, let owner else { return }
        let eligible = sessions.values.filter { $0.owner == owner }
        guard !eligible.isEmpty else { return }
        let pendingBySession = Dictionary(grouping: items.filter { $0.state == .pending }, by: \.sessionID)
        // Stopped sessions get their own drain lane, alternating with the active backlog, so a
        // finished session is never starved by a live session (and vice versa).
        let finishing = Set(eligible.filter { session in
            pendingBySession[session.sessionID]?.contains { $0.kind == .finish } == true || awaitingSyncComplete(session)
        }.map(\.sessionID))
        let others = Set(eligible.map(\.sessionID)).subtracting(finishing)
        var lanes: [Set<String>] = []
        if !finishing.isEmpty, !others.isEmpty {
            lanes = preferFinishingLane ? [finishing, others] : [others, finishing]
        } else {
            lanes = [finishing.isEmpty ? others : finishing]
        }
        for lane in lanes where pump(lane: lane, pendingBySession: pendingBySession, owner: owner, now: now) {
            preferFinishingLane.toggle()
            return
        }
    }

    private func pump(lane: Set<String>, pendingBySession: [String: [UploadItemRecord]], owner: UploadOwner,
                      now: TimeInterval) -> Bool {
        // 1. session:start for any lane session that has work but no server session id yet.
        let needsStart = lane.compactMap { sessions[$0] }.filter { session in
            session.serverSessionID == nil && !session.startQuarantined && session.startPayload != nil
                && (pendingBySession[session.sessionID]?.isEmpty == false || awaitingSyncComplete(session)
                    || session.sessionID == activeSessionID)
        }.sorted { (pendingBySession[$0.sessionID]?.first?.enqueueOrder ?? .max) < (pendingBySession[$1.sessionID]?.first?.enqueueOrder ?? .max) }
        if let session = needsStart.first, let payload = session.startPayload {
            sendSessionStart(session.sessionID, payload: payload, owner: owner)
            return true
        }
        // 2. Next ledger item by fair class order.
        var heads: [UploadScheduler.Lane: UploadItemRecord] = [:]
        for item in items where item.state == .pending && lane.contains(item.sessionID) {
            guard let session = sessions[item.sessionID] else { continue }
            // Everything except diagnostics needs the server session id.
            if item.kind != .diagnostic && session.serverSessionID == nil { continue }
            let laneClass: UploadScheduler.Lane
            switch item.kind {
            case .telemetry: laneClass = .telemetry
            case .marker, .diagnostic: laneClass = .aux
            case .arkit: laneClass = .arkit
            case .finish:
                if sessionsWithHeldAbsoluteAltitude.contains(item.sessionID) { continue }
                // Finish is eligible only after every earlier required item of its own session
                // (other sessions' backlog is not part of this barrier).
                let blocked = pendingBySession[item.sessionID]?.contains { $0.kind != .finish && $0.enqueueOrder < item.enqueueOrder } ?? false
                if blocked { continue }
                laneClass = .finish
            }
            if heads[laneClass] == nil { heads[laneClass] = item }
        }
        if let choice = scheduler.choose(available: Set(heads.keys), now: now), let item = heads[choice],
           let session = sessions[item.sessionID] {
            scheduler.record(choice, now: now)
            sendItem(item, serverSessionID: session.serverSessionID ?? "", owner: owner)
            return true
        }
        // 3. syncComplete once the session's own ledger is clean (pending 0, quarantine 0).
        for id in lane {
            guard let session = sessions[id], awaitingSyncComplete(session), let manifest = session.finishAck,
                  session.serverSessionID != nil else { continue }
            let remaining = items.contains { $0.sessionID == id && ($0.state == .pending || $0.state == .quarantined) }
            guard !remaining else { continue }
            sendSyncComplete(id, serverSessionID: session.serverSessionID, manifest: manifest, owner: owner)
            return true
        }
        return false
    }

    // MARK: Senders

    private func sendSessionStart(_ id: String, payload: Data, owner: UploadOwner) {
        print("[UploadEngine] sending session:start clientSessionId=\(id)")
        let ticket = makeTicket(.start(id), owner: owner)
        dispatch(ticket, build: {
            let start = try TrackingJSONCodec.makeDecoder().decode(SessionStartPayload.self, from: payload)
            return try TelemetryWireEncoding.requestText(type: "session:start", payload: start, requestId: ticket.requestId)
        }) { [weak self] resolution in
            guard let self else { return }
            switch resolution {
            case let .ack(true, _, data):
                guard let data, let response = try? TrackingJSONCodec.makeDecoder().decode(SessionStartResponse.self, from: data) else {
                    print("[UploadEngine] session:start ACK missing data.sessionId clientSessionId=\(id)")
                    return self.scheduleRetry()
                }
                if let ack = response.strideCalibration {
                    print("[UploadEngine] session:start ACK strideCalibration status=\(ack.status) reason=\(ack.reason ?? "—")")
                }
                self.sessions[id]?.serverSessionID = response.sessionId
                self.sessions[id]?.startQuarantined = false
                self.commitLedger({ try $0.setServerSessionID(response.sessionId, sessionID: id) }) {
                    if let uuid = UUID(uuidString: id) { self.onServerSessionStarted?(uuid, response.sessionId) }
                    if response.supportedTelemetryFeatures?.contains("absoluteAltitudeV1") == true {
                        self.absoluteAltitudeSupportedSessions.insert(id)
                        if let uuid = UUID(uuidString: id) { self.onAbsoluteAltitudeSupported?(uuid) }
                        self.releaseAbsoluteAltitude(sessionID: id)
                    }
                    if id == self.activeSessionID { self.sendStatus() }
                }
            case let .ack(false, error, _):
                if self.isRetryable(error) { return self.scheduleRetry() }
                // Held, not deleted: retried automatically on the next login/server change.
                print("[UploadEngine] session:start rejected code=\(error?.code ?? "—"); holding clientSessionId=\(id)")
                self.sessions[id]?.startQuarantined = true
                self.commitLedger({ try $0.setStartQuarantined(true, sessionID: id) })
            case .timeout, .transportFailed:
                self.scheduleRetry()
            case let .encodingFailed(message):
                print("[UploadEngine] session:start encode failed clientSessionId=\(id) error=\(message)")
                self.sessions[id]?.startQuarantined = true
                self.commitLedger({ try $0.setStartQuarantined(true, sessionID: id) })
            }
        }
    }

    private func releaseAbsoluteAltitude(sessionID: String) {
        guard let id = UUID(uuidString: sessionID) else { return }
        store.async({ access in
            try access.createTelemetryBatches(sessionID: id, maximumSamples: 64, minimumSamples: 1,
                                              includeAbsoluteAltitude: true) { batchID, rows in
                let payload = try RawSampleDecoding.telemetryBatch(batchID: batchID, clientSessionID: sessionID,
                                                                   rows: rows, createdAt: Date())
                return try TrackingJSONCodec.makeEncoder().encode(payload)
            }
        }) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(items):
                self.sessionsWithHeldAbsoluteAltitude.remove(sessionID)
                self.merge(items)
            case let .failure(error): self.onStorageError?("ABSOLUTE_ALTITUDE_RELEASE_FAILED: \(error)")
            }
            self.notifyCount()
            self.synchronize()
        }
    }

    private func sendItem(_ item: UploadItemRecord, serverSessionID: String, owner: UploadOwner) {
        let key = item.key
        let ticket = makeTicket(.item(key, sessionID: item.sessionID), owner: owner)
        let payload = item.payload
        let sessionID = item.sessionID
        print("[UploadEngine] sending \(item.kind.messageType) item=\(item.itemID)")
        dispatch(ticket, build: {
            try TelemetryWireEncoding.requestText(kind: key.kind, payload: payload, serverSessionId: serverSessionID,
                                                  clientSessionId: sessionID, requestId: ticket.requestId)
        }) { [weak self] resolution in
            guard let self else { return }
            switch resolution {
            case .ack(true, _, _):
                if key.kind == .finish {
                    let manifest = (try? TrackingJSONCodec.makeDecoder().decode(FinishPayload.self, from: payload))?.lastSequences
                    let followUp = Self.diagnosticDraft(eventType: "SESSION_FINISH_ACK", metadata: [:])
                    self.commitLedger({ try $0.acknowledgeFinish(sessionID: sessionID, itemID: key.itemID, manifest: manifest, followUp: followUp) }) { diagnostic in
                        self.removeItem(key)
                        self.sessions[sessionID]?.finishAck = manifest
                        self.sessions[sessionID]?.syncState = .finishAcknowledged
                        if let diagnostic { self.merge([diagnostic]) }
                    }
                } else {
                    self.commitLedger({ try $0.markAcked(key) }) { self.removeItem(key) }
                }
            case let .ack(false, error, _):
                self.handleItemFailure(error: error, key: key, sessionID: sessionID)
            case .timeout, .transportFailed:
                self.scheduleRetry()
            case let .encodingFailed(message):
                // The same encoding fails every time: quarantine with the original payload kept.
                self.quarantine(key, error: AckError(code: "SERIALIZATION_FAILED", message: message, status: nil, retryable: false))
            }
        }
    }

    private func sendSyncComplete(_ id: String, serverSessionID: String?, manifest: LastSequencesPayload, owner: UploadOwner) {
        let ticket = makeTicket(.syncComplete(id), owner: owner)
        let payload = SyncCompletePayload(clientSessionId: id, sessionId: serverSessionID, lastSequences: manifest)
        dispatch(ticket, build: {
            try TelemetryWireEncoding.requestText(type: "session:syncComplete", payload: payload, requestId: ticket.requestId)
        }) { [weak self] resolution in
            guard let self else { return }
            switch resolution {
            case let .ack(true, _, data):
                // Must be a typed `synchronized` boolean; anything else is a protocol error and is
                // never shown as complete.
                let text = data.map { String(decoding: $0, as: UTF8.self) } ?? "missing"
                guard let data, let response = try? TrackingJSONCodec.makeDecoder().decode(SyncCompleteResponse.self, from: data) else {
                    self.sessions[id]?.syncState = .protocolError
                    self.commitLedger({ try $0.setSyncState(.protocolError, sessionID: id) }) {
                        self.logDiagnostic(eventType: "SYNC_COMPLETE_PROTOCOL_ERROR", metadata: ["data": text], clientSessionId: id)
                    }
                    return
                }
                if response.synchronized {
                    self.sessions[id]?.syncState = .complete
                    self.commitLedger({ try $0.setSyncState(.complete, sessionID: id) }) {
                        self.logDiagnostic(eventType: "SYNC_COMPLETE_ACK", clientSessionId: id)
                    }
                } else {
                    self.sessions[id]?.syncState = .incomplete
                    self.commitLedger({ try $0.setSyncState(.incomplete, sessionID: id) }) {
                        self.logDiagnostic(eventType: "SYNC_INCOMPLETE", metadata: ["manifest": text], clientSessionId: id)
                    }
                }
            case let .ack(false, error, _):
                if self.isRetryable(error) { return self.scheduleRetry() }
                self.sessions[id]?.syncState = .quarantined
                self.commitLedger({ try $0.setSyncState(.quarantined, sessionID: id) })
            case .timeout, .transportFailed:
                self.scheduleRetry()
            case .encodingFailed:
                self.sessions[id]?.syncState = .protocolError
                self.commitLedger({ try $0.setSyncState(.protocolError, sessionID: id) })
            }
        }
    }

    // MARK: Failure handling

    /// One re-handshake retry for a session-restart error, bounded backoff for anything else
    /// retryable, quarantine (held with its error, never auto-retried) for a permanent rejection.
    private func handleItemFailure(error: AckError?, key: UploadItemKey, sessionID: String) {
        if let code = error?.code, Self.sessionRestartCodes.contains(code) {
            let alreadyRetried = items.first { $0.key == key }?.restartRetried ?? true
            guard !alreadyRetried else { return quarantine(key, error: error ?? AckError(code: code, message: nil, status: nil, retryable: false)) }
            print("[UploadEngine] \(code) for item=\(key.itemID); re-sending session:start then retrying once")
            updateItem(key) { $0.restartRetried = true }
            sessions[sessionID]?.serverSessionID = nil
            commitLedger({ try $0.markRestartRetried(key, sessionID: sessionID) })
            return
        }
        if isRetryable(error) {
            if let error {
                updateItem(key) { $0.lastError = error }
                store.async({ try $0.recordRetryableError(key, error: error) }) { _ in }
            }
            scheduleRetry()
        } else {
            quarantine(key, error: error ?? AckError(code: "UNKNOWN", message: nil, status: nil, retryable: false))
        }
    }

    private func quarantine(_ key: UploadItemKey, error: AckError) {
        print("[UploadEngine] quarantined item=\(key.itemID) code=\(error.code ?? "UNKNOWN")")
        commitLedger({ try $0.quarantine(key, error: error) }) {
            self.updateItem(key) { $0.state = .quarantined; $0.lastError = error }
        }
    }

    /// `retryable: true` (or any 5xx-shaped error, or no structured error at all — a timeout or
    /// disconnect) keeps the item queued. Only a confirmed `retryable: false` (or 4xx) quarantines.
    private func isRetryable(_ error: AckError?) -> Bool {
        guard let error else { return true }
        if let retryable = error.retryable { return retryable }
        return (error.status ?? 500) >= 500
    }

    private func scheduleRetry() {
        let notBefore = ProcessInfo.processInfo.systemUptime + Self.retryDelaySeconds
        retryNotBeforeUptime = max(retryNotBeforeUptime ?? 0, notBefore)
        scheduleWake(at: retryNotBeforeUptime ?? notBefore)
    }

    private func scheduleWake(at uptime: TimeInterval) {
        retryWake?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.retryWake = nil
                self?.synchronize()
            }
        }
        retryWake = work
        let delay = max(0, uptime - ProcessInfo.processInfo.systemUptime)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Ledger mutation after a confirmed ACK. Blocks the next pump until COMMIT; on failure the
    /// memory state is left as before (item still PENDING) and the storage error is surfaced.
    private func commitLedger(_ body: @escaping @Sendable (CollectionStoreAccess) throws -> Void,
                              then apply: (@MainActor @Sendable () -> Void)? = nil) {
        commitLedger(body) { (_: Void) in apply?() }
    }

    private func commitLedger<T: Sendable>(_ body: @escaping @Sendable (CollectionStoreAccess) throws -> T,
                                           then apply: @escaping @MainActor @Sendable (T) -> Void) {
        storageMutationPending = true
        store.async(body) { [weak self] result in
            guard let self else { return }
            self.storageMutationPending = false
            switch result {
            case let .success(value):
                apply(value)
            case let .failure(error):
                print("[UploadEngine] ledger commit failed error=\(error)")
                self.onStorageError?("UPLOAD_LEDGER_COMMIT_FAILED: \(error)")
                self.scheduleRetry()
            }
            self.notifyCount()
            self.synchronize()
        }
    }

    // MARK: Transport

    private func makeTicket(_ target: Target, owner: UploadOwner) -> Ticket {
        Ticket(requestId: UUID().uuidString, target: target, owner: owner, connectionGeneration: connectionGeneration)
    }

    /// Stores the ticket as in-flight BEFORE encoding starts; the encode completion, send
    /// completion, ACK and timeout are each checked against it.
    private func dispatch(_ ticket: Ticket, build: @escaping @Sendable () throws -> String,
                          completion: @escaping (Resolution) -> Void) {
        inFlight = InFlight(ticket: ticket, timeout: nil, completion: completion)
        encodingQueue.async { [weak self] in
            let result = Result { try build() }
            DispatchQueue.main.async {
                guard let self else { return }
                guard self.inFlight?.ticket == ticket, ticket.connectionGeneration == self.connectionGeneration,
                      self.owner == ticket.owner, self.webSocket.state == .connected else {
                    print("[UploadEngine] discarded stale encoding completion requestId=\(ticket.requestId)")
                    return
                }
                switch result {
                case let .failure(error):
                    self.resolve(ticket.requestId, .encodingFailed(String(reflecting: error)))
                case let .success(text):
                    // The ACK deadline starts at the actual send, not at encode start.
                    let timeout = DispatchWorkItem { [weak self] in
                        MainActor.assumeIsolated {
                            print("[UploadEngine] ACK timeout requestId=\(ticket.requestId); will resend with the same item ID")
                            self?.resolve(ticket.requestId, .timeout)
                        }
                    }
                    self.inFlight?.timeout = timeout
                    DispatchQueue.main.asyncAfter(deadline: .now() + Self.ackTimeoutSeconds, execute: timeout)
                    self.webSocket.send(text: text) { [weak self] error in
                        guard let error else { return }
                        DispatchQueue.main.async {
                            self?.resolve(ticket.requestId, .transportFailed(error.localizedDescription))
                        }
                    }
                }
            }
        }
    }

    private func handle(message text: String) {
        guard let data = text.data(using: .utf8),
              let ack = try? JSONDecoder().decode(WebSocketAck.self, from: data) else {
            print("[UploadEngine] ignored non-ACK message bytes=\(text.utf8.count)")
            return
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let responseData = object?["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
        let errorData = (object?["error"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        let error = errorData.flatMap { try? JSONDecoder().decode(AckError.self, from: $0) }
        print("[UploadEngine] ACK requestId=\(ack.requestId) ok=\(ack.ok) errorCode=\(error?.code ?? "—") retryable=\(error?.retryable.map(String.init) ?? "—")")
        guard let current = inFlight, current.ticket.requestId == ack.requestId,
              current.ticket.connectionGeneration == connectionGeneration else {
            print("[UploadEngine] ignored ACK for a request not in flight requestId=\(ack.requestId)")
            return
        }
        resolve(ack.requestId, .ack(ok: ack.ok, error: error, data: responseData))
    }

    /// The only place `inFlight` is cleared and its completion invoked.
    private func resolve(_ requestId: String, _ resolution: Resolution) {
        guard let current = inFlight, current.ticket.requestId == requestId else { return }
        current.timeout?.cancel()
        inFlight = nil
        current.completion(resolution)
        notifyCount()
        synchronize()
    }

    private func handleConnected() {
        connectionGeneration &+= 1
        // A reconnect repeats session:start with the same clientSessionId so the server can
        // restore (rather than replace) the active session.
        if let id = activeSessionID { requireHandshake(id) }
        synchronize()
    }

    /// The next pump sends session:start again (idempotent on the server) before this session's items.
    @discardableResult
    private func requireHandshake(_ id: String) -> Bool {
        guard sessions[id]?.serverSessionID != nil else { return false }
        sessions[id]?.serverSessionID = nil
        store.async({ try $0.setServerSessionID(nil, sessionID: id) }) { _ in }
        print("[UploadEngine] handshake required clientSessionId=\(id)")
        return true
    }

    private func handleDisconnected() {
        connectionGeneration &+= 1
        if let current = inFlight {
            // The durable item remains PENDING; the next connection re-handshakes.
            current.timeout?.cancel()
            inFlight = nil
        }
        print("[UploadEngine] WebSocket disconnected; retaining pending=\(pendingCount)")
    }

    private func sendStatus() {
        guard webSocket.state == .connected, let id = activeSessionID,
              let serverSessionId = sessions[id]?.serverSessionID else { return }
        let payload = CollectorStatusPayload(
            sessionId: serverSessionId, collecting: true,
            locationSampleCount: sampleCounts.location, motionSampleCount: sampleCounts.motion,
            pendingBatchCount: items.filter { $0.sessionID == id && $0.kind == .telemetry && $0.state == .pending }.count)
        // Fire-and-forget: never goes through `inFlight` and never blocks the upload chain.
        let requestId = UUID().uuidString
        encodingQueue.async { [weak self] in
            guard let text = try? TelemetryWireEncoding.requestText(type: "collector:status", payload: payload, requestId: requestId) else { return }
            DispatchQueue.main.async { self?.webSocket.send(text: text) { _ in } }
        }
    }
}
