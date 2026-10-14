import Foundation

// MARK: - Records

nonisolated enum CaptureState: String, Codable, Sendable {
    case recording
    case stopping
    case stopped
    /// Imported from the legacy upload queue without a resumable capture snapshot.
    case legacyUploadOnly
}

nonisolated enum SyncState: String, Codable, Sendable {
    case pending
    case finishAcknowledged
    case complete
    case incomplete
    case quarantined
    case protocolError
}

nonisolated enum UploadItemState: String, Codable, Sendable {
    case pending = "PENDING"
    case acked = "ACKED"
    case quarantined = "QUARANTINED"
    /// Legacy item whose owner could not be established. Never sent automatically.
    case heldOrphaned = "HELD_ORPHANED"
}

nonisolated struct UploadItemDraft: Sendable, Equatable {
    let kind: UploadKind
    let itemID: String
    let payload: Data
}

nonisolated struct UploadItemRecord: Sendable, Equatable {
    let enqueueOrder: Int64
    let sessionID: String
    let kind: UploadKind
    let itemID: String
    var state: UploadItemState
    let payload: Data
    let createdAtMs: Int64
    var restartRetried: Bool
    var lastError: AckError?

    var key: UploadItemKey { UploadItemKey(kind: kind, itemID: itemID) }
}

nonisolated struct UploadItemKey: Hashable, Sendable {
    let kind: UploadKind
    let itemID: String
}

nonisolated struct SessionSyncRecord: Sendable, Equatable {
    let sessionID: String
    var owner: UploadOwner?
    var startPayload: Data?
    var serverSessionID: String?
    var startQuarantined: Bool
    var finishAck: LastSequencesPayload?
    var syncState: SyncState
    var captureState: CaptureState
}

nonisolated struct UploadLedgerSnapshot: Sendable {
    let sessions: [SessionSyncRecord]
    let items: [UploadItemRecord]
}

nonisolated struct StopIntent: Codable, Sendable, Equatable {
    let sessionID: UUID
    let endedAt: Date
    let reason: String
    let interrupted: Bool
    let requestedAt: Date
}

nonisolated struct StoredSession: Sendable {
    let id: UUID
    let captureState: CaptureState
    let syncState: SyncState
    let owner: UploadOwner?
    let snapshot: ActiveCollectionState?
    let stopIntent: StopIntent?
    let manifest: LastSequencesPayload?
}

nonisolated struct StreamLeaseRow: Sendable, Equatable {
    var reservedExclusive: Int
    var lastRecorded: Int
    var recordedCount: Int
}

nonisolated struct RawRecordDraft: Sendable {
    let stream: String
    let sequence: Int
    let measuredAtMs: Int64
    let payload: Data
    /// Rows that are uploaded as their own ledger item (ARKit poses, markers) are linked to that
    /// item at insert time so the telemetry batcher never picks them up.
    let uploadItem: UploadItemDraft?
}

nonisolated struct RawRow: Sendable {
    let stream: String
    let sequence: Int
    let measuredAtMs: Int64
    let payload: Data
    let batchID: String?
}

nonisolated enum StoreFailurePoint: Equatable, Sendable {
    case sessionCreate, leaseReserve, rawCommit, batchCommit, stopIntent, finalize, ledgerUpdate, uploadInsert, snapshot
}

nonisolated enum CollectionStoreError: Error, Equatable, CustomStringConvertible {
    case unavailable(String)
    case rawConflict(stream: String, sequence: Int)
    case sessionNotFound(String)
    case invalidState(String)
    case injected(String)
    case decode(String)
    case migration(String)

    var description: String {
        switch self {
        case let .unavailable(message): return "STORE_UNAVAILABLE: \(message)"
        case let .rawConflict(stream, sequence): return "RAW_SEQUENCE_CONFLICT stream=\(stream) sequence=\(sequence)"
        case let .sessionNotFound(id): return "SESSION_NOT_FOUND_IN_STORE \(id)"
        case let .invalidState(message): return "INVALID_STORE_STATE: \(message)"
        case let .injected(point): return "INJECTED_FAILURE: \(point)"
        case let .decode(message): return "STORE_DECODE_FAILED: \(message)"
        case let .migration(message): return "MIGRATION_FAILED: \(message)"
        }
    }
}

nonisolated func epochMilliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1_000).rounded())
}

// MARK: - Store

/// The single canonical local store: raw samples, sessions, sequence leases and the upload
/// ledger share one SQLite database so a raw commit and its upload item are one transaction.
///
/// `@unchecked Sendable`: the only mutable state (`database`, `openFailure`) is read and written
/// exclusively on `queue`. Callers either hop with `sync` (never from the main thread or from
/// `queue` itself) or `async` (completion delivered on the main queue).
nonisolated final class CollectionStore: @unchecked Sendable {
    static let databaseFileName = "collection-v2.sqlite"
    static let schemaVersion = 1

    let queue = DispatchQueue(label: "CampusCollector.collection-store", qos: .utility)
    let directory: URL
    let legacyDirectory: URL
    private let failureInjector: (@Sendable (StoreFailurePoint) throws -> Void)?
    private var database: SQLiteDatabase?
    private var openFailure: String?
    private(set) var migrationReport: LegacyMigrationReport?

    static func defaultDirectory(fileManager: FileManager = .default) -> URL {
        let support = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                            appropriateFor: nil, create: true)) ?? fileManager.temporaryDirectory
        return support.appendingPathComponent("CampusCollector", isDirectory: true)
    }

    /// Opening and the one-time legacy migration run asynchronously on `queue`; every later
    /// operation is queued behind them, so no caller can observe a half-migrated database.
    init(directory: URL? = nil, legacyDirectory: URL? = nil,
         failureInjector: (@Sendable (StoreFailurePoint) throws -> Void)? = nil) {
        let resolved = directory ?? Self.defaultDirectory()
        self.directory = resolved
        self.legacyDirectory = legacyDirectory ?? resolved
        self.failureInjector = failureInjector
        queue.async { self.open() }
    }

    private func open() {
        dispatchPrecondition(condition: .onQueue(queue))
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let db = try SQLiteDatabase(path: directory.appendingPathComponent(Self.databaseFileName).path)
            let check = try db.integrityCheck()
            guard check == "ok" else { throw CollectionStoreError.unavailable("integrity check: \(check)") }
            try Self.migrateSchema(db)
            do {
                migrationReport = try LegacyMigrator.run(database: db, legacyRoot: legacyDirectory, now: Date())
            } catch {
                throw CollectionStoreError.migration(String(describing: error))
            }
            database = db
        } catch {
            // Keep the files exactly as they are and refuse to continue with an empty store.
            openFailure = String(describing: error)
            print("[CollectionStore] open failed error=\(openFailure ?? "—")")
        }
    }

    private static func migrateSchema(_ db: SQLiteDatabase) throws {
        let version = db.userVersion
        guard version < schemaVersion else {
            guard version == schemaVersion else {
                throw CollectionStoreError.unavailable("database schema \(version) is newer than this build (\(schemaVersion))")
            }
            return
        }
        try db.transaction {
            try db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
              session_id TEXT PRIMARY KEY,
              collector_id TEXT NOT NULL,
              server_key TEXT NOT NULL,
              owner_orphaned INTEGER NOT NULL DEFAULT 0,
              capture_state TEXT NOT NULL,
              sync_state TEXT NOT NULL,
              started_at_ms INTEGER NOT NULL,
              snapshot_json BLOB NOT NULL,
              stop_intent_json BLOB,
              finalized_manifest_json BLOB,
              start_payload_json BLOB,
              server_session_id TEXT,
              start_quarantined INTEGER NOT NULL DEFAULT 0,
              finish_ack_json BLOB,
              legacy_source TEXT
            );
            CREATE TABLE IF NOT EXISTS sequence_leases (
              session_id TEXT NOT NULL REFERENCES sessions(session_id),
              stream TEXT NOT NULL,
              reserved_exclusive INTEGER NOT NULL DEFAULT 0,
              last_recorded INTEGER NOT NULL DEFAULT -1,
              recorded_count INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (session_id, stream)
            );
            CREATE TABLE IF NOT EXISTS upload_items (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL REFERENCES sessions(session_id),
              kind TEXT NOT NULL,
              item_id TEXT NOT NULL,
              state TEXT NOT NULL,
              payload_json BLOB NOT NULL,
              error_json BLOB,
              created_at_ms INTEGER NOT NULL,
              restart_retried INTEGER NOT NULL DEFAULT 0,
              acked_at_ms INTEGER,
              UNIQUE(kind, item_id)
            );
            CREATE INDEX IF NOT EXISTS upload_pending ON upload_items(state, session_id, kind, enqueue_order);
            CREATE TABLE IF NOT EXISTS raw_samples (
              session_id TEXT NOT NULL REFERENCES sessions(session_id),
              stream TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              measured_at_ms INTEGER NOT NULL,
              payload_json BLOB NOT NULL,
              batch_id TEXT,
              PRIMARY KEY (session_id, stream, sequence)
            );
            CREATE INDEX IF NOT EXISTS raw_unbatched ON raw_samples(session_id, batch_id);
            CREATE TABLE IF NOT EXISTS capture_audit (
              audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL,
              stream TEXT NOT NULL,
              reason TEXT NOT NULL,
              measured_at_ms INTEGER,
              payload_json BLOB,
              recorded_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migrations (
              source_name TEXT PRIMARY KEY,
              source_sha256 TEXT NOT NULL,
              imported_at_ms INTEGER NOT NULL
            );
            """)
            try db.setUserVersion(schemaVersion)
        }
    }

    private func access() throws -> CollectionStoreAccess {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let database else {
            throw CollectionStoreError.unavailable(openFailure ?? "not open")
        }
        return CollectionStoreAccess(db: database, failureInjector: failureInjector)
    }

    /// Blocking call for the collection queue (or tests). Never call from the main thread.
    func sync<T>(_ body: (CollectionStoreAccess) throws -> T) throws -> T {
        dispatchPrecondition(condition: .notOnQueue(queue))
        return try queue.sync { try body(try access()) }
    }

    /// Non-blocking call; `completion` runs on the main queue.
    func async<T: Sendable>(_ body: @escaping @Sendable (CollectionStoreAccess) throws -> T,
                            completion: @escaping @MainActor @Sendable (Result<T, Error>) -> Void) {
        queue.async {
            let result = Result { try body(try self.access()) }
            DispatchQueue.main.async { completion(result) }
        }
    }

    /// Fire-and-forget for callers that already run off the main thread and want the result on
    /// the store queue itself.
    func enqueue(_ body: @escaping @Sendable (Result<CollectionStoreAccess, Error>) -> Void) {
        queue.async { body(Result { try self.access() }) }
    }
}

// MARK: - Access (valid only on the store queue)

nonisolated struct CollectionStoreAccess {
    fileprivate let db: SQLiteDatabase
    fileprivate let failureInjector: (@Sendable (StoreFailurePoint) throws -> Void)?

    private let encoder = TrackingJSONCodec.makeEncoder()
    private let decoder = TrackingJSONCodec.makeDecoder()

    fileprivate init(db: SQLiteDatabase, failureInjector: (@Sendable (StoreFailurePoint) throws -> Void)?) {
        self.db = db
        self.failureInjector = failureInjector
    }

    private func inject(_ point: StoreFailurePoint) throws {
        try failureInjector?(point)
    }

    func transaction<T>(_ body: () throws -> T) throws -> T { try db.transaction(body) }

    // MARK: Sessions

    func createSession(snapshot: ActiveCollectionState, owner: UploadOwner, startPayload: Data,
                       streams: [String]) throws {
        try db.transaction {
            try inject(.sessionCreate)
            let id = snapshot.session.id.uuidString
            try db.run("""
                INSERT INTO sessions (session_id, collector_id, server_key, capture_state, sync_state,
                  started_at_ms, snapshot_json, start_payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, [.text(id), .text(owner.collectorId), .text(owner.serverKey),
                      .text(CaptureState.recording.rawValue), .text(SyncState.pending.rawValue),
                      .integer(epochMilliseconds(snapshot.session.startedAt)),
                      .blob(try encoder.encode(snapshot)), .blob(startPayload)])
            for stream in streams {
                try db.run("INSERT OR IGNORE INTO sequence_leases (session_id, stream) VALUES (?, ?)",
                           [.text(id), .text(stream)])
            }
        }
    }

    func session(id: UUID) throws -> StoredSession? {
        try db.queryOne("""
            SELECT session_id, capture_state, sync_state, collector_id, server_key, owner_orphaned,
                   snapshot_json, stop_intent_json, finalized_manifest_json
            FROM sessions WHERE session_id = ?
            """, [.text(id.uuidString)], storedSession)
    }

    func sessions(in states: Set<CaptureState>) throws -> [StoredSession] {
        try db.query("""
            SELECT session_id, capture_state, sync_state, collector_id, server_key, owner_orphaned,
                   snapshot_json, stop_intent_json, finalized_manifest_json
            FROM sessions ORDER BY started_at_ms DESC
            """, [], storedSession).filter { states.contains($0.captureState) }
    }

    private func storedSession(_ row: SQLiteRow) throws -> StoredSession {
        guard let id = row.text(0).flatMap(UUID.init(uuidString:)),
              let capture = row.text(1).flatMap(CaptureState.init(rawValue:)),
              let sync = row.text(2).flatMap(SyncState.init(rawValue:)) else {
            throw CollectionStoreError.decode("sessions row")
        }
        let owner = row.int(5) == 0 ? UploadOwner(collectorId: row.text(3) ?? "", serverKey: row.text(4) ?? "") : nil
        let snapshot: ActiveCollectionState?
        if capture == .legacyUploadOnly {
            snapshot = nil
        } else {
            guard let data = row.blob(6) else { throw CollectionStoreError.decode("snapshot missing") }
            do { snapshot = try decoder.decode(ActiveCollectionState.self, from: data) }
            catch { throw CollectionStoreError.decode("snapshot \(id.uuidString): \(error)") }
        }
        let intent = try row.blob(7).map { try decoder.decode(StopIntent.self, from: $0) }
        let manifest = try row.blob(8).map { try decoder.decode(LastSequencesPayload.self, from: $0) }
        return StoredSession(id: id, captureState: capture, syncState: sync, owner: owner,
                             snapshot: snapshot, stopIntent: intent, manifest: manifest)
    }

    func updateSnapshot(_ snapshot: ActiveCollectionState) throws {
        try inject(.snapshot)
        let changed = try db.run("UPDATE sessions SET snapshot_json = ? WHERE session_id = ?",
                                 [.blob(try encoder.encode(snapshot)), .text(snapshot.session.id.uuidString)])
        guard changed == 1 else { throw CollectionStoreError.sessionNotFound(snapshot.session.id.uuidString) }
    }

    // MARK: Leases

    func leases(sessionID: UUID) throws -> [String: StreamLeaseRow] {
        let rows = try db.query("""
            SELECT stream, reserved_exclusive, last_recorded, recorded_count
            FROM sequence_leases WHERE session_id = ?
            """, [.text(sessionID.uuidString)]) { row in
            (row.text(0) ?? "", StreamLeaseRow(reservedExclusive: row.int(1), lastRecorded: row.int(2), recordedCount: row.int(3)))
        }
        return Dictionary(rows, uniquingKeysWith: { first, _ in first })
    }

    /// Durably raises (never lowers) the first unreserved sequence of `stream`.
    func reserveLease(sessionID: UUID, stream: String, reservedExclusive: Int) throws {
        try db.transaction {
            try inject(.leaseReserve)
            try db.run("""
                INSERT INTO sequence_leases (session_id, stream, reserved_exclusive) VALUES (?, ?, ?)
                ON CONFLICT(session_id, stream) DO UPDATE SET
                  reserved_exclusive = MAX(reserved_exclusive, excluded.reserved_exclusive)
                """, [.text(sessionID.uuidString), .text(stream), .int(reservedExclusive)])
        }
    }

    /// Final manifest: the last sequence actually preserved per stream, `-1` for an empty stream.
    func manifest(sessionID: UUID) throws -> LastSequencesPayload {
        let rows = try leases(sessionID: sessionID)
        func last(_ stream: String) -> Int {
            guard let row = rows[stream], row.recordedCount > 0, row.lastRecorded > 0 else { return -1 }
            return row.lastRecorded
        }
        let absoluteAltitude = last("absoluteAltitude")
        return LastSequencesPayload(location: last("location"), motion: last("motion"),
                                    altimeter: last("altimeter"), pedometer: last("pedometer"),
                                    absoluteAltitude: absoluteAltitude >= 0 ? absoluteAltitude : nil)
    }

    // MARK: Raw commit

    /// One transaction: raw rows + linked ledger items + per-stream durable counters + snapshot.
    /// Retrying the same records (same sequences) is idempotent; a different payload under an
    /// already-stored sequence is a hard conflict, never silently overwritten.
    func commitRaw(sessionID: UUID, records: [RawRecordDraft],
                   snapshot: ActiveCollectionState?) throws -> [UploadItemRecord] {
        try db.transaction {
            try inject(.rawCommit)
            let id = sessionID.uuidString
            let now = epochMilliseconds(Date())
            var inserted: [String: (last: Int, count: Int)] = [:]
            var items: [UploadItemRecord] = []
            for record in records {
                let changed = try db.run("""
                    INSERT OR IGNORE INTO raw_samples (session_id, stream, sequence, measured_at_ms, payload_json, batch_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """, [.text(id), .text(record.stream), .int(record.sequence), .integer(record.measuredAtMs),
                          .blob(record.payload), .optionalText(record.uploadItem?.itemID)])
                if changed == 0 {
                    let existing = try db.queryOne("""
                        SELECT payload_json FROM raw_samples WHERE session_id = ? AND stream = ? AND sequence = ?
                        """, [.text(id), .text(record.stream), .int(record.sequence)]) { $0.blob(0) }
                    guard existing == record.payload else {
                        throw CollectionStoreError.rawConflict(stream: record.stream, sequence: record.sequence)
                    }
                } else {
                    let previous = inserted[record.stream] ?? (last: -1, count: 0)
                    inserted[record.stream] = (max(previous.last, record.sequence), previous.count + 1)
                }
                if let draft = record.uploadItem {
                    items.append(try insertItem(sessionID: id, draft: draft, state: .pending, createdAtMs: now))
                }
            }
            for (stream, value) in inserted {
                try db.run("""
                    INSERT INTO sequence_leases (session_id, stream, reserved_exclusive, last_recorded, recorded_count)
                    VALUES (?, ?, 0, ?, ?)
                    ON CONFLICT(session_id, stream) DO UPDATE SET
                      last_recorded = MAX(last_recorded, excluded.last_recorded),
                      recorded_count = recorded_count + excluded.recorded_count
                    """, [.text(id), .text(stream), .int(value.last), .int(value.count)])
            }
            if let snapshot { try updateSnapshot(snapshot) }
            return items
        }
    }

    // MARK: Telemetry batches

    func unbatchedTelemetryCount(sessionID: UUID) throws -> Int {
        try db.queryOne("SELECT COUNT(*) FROM raw_samples WHERE session_id = ? AND batch_id IS NULL AND stream != ?",
                        [.text(sessionID.uuidString), .text(CaptureStream.absoluteAltitude.rawValue)]) { $0.int(0) } ?? 0
    }

    func heldAbsoluteAltitudeCount(sessionID: String) throws -> Int {
        try db.queryOne("SELECT COUNT(*) FROM raw_samples WHERE session_id = ? AND batch_id IS NULL AND stream = ?",
                        [.text(sessionID), .text(CaptureStream.absoluteAltitude.rawValue)]) { $0.int(0) } ?? 0
    }

    func sessionsWithHeldAbsoluteAltitude() throws -> Set<String> {
        Set(try db.query("""
            SELECT DISTINCT session_id FROM raw_samples WHERE stream = ? AND batch_id IS NULL
            """, [.text(CaptureStream.absoluteAltitude.rawValue)]) { $0.text(0) ?? "" })
    }

    /// A feature decision is scoped to the latest session:start response. After process restart,
    /// force a fresh handshake for sessions that still have locally-held absolute altitude rows.
    func requireFeatureRehandshakeForHeldAbsoluteAltitude() throws {
        try db.run("""
            UPDATE sessions SET server_session_id = NULL
            WHERE EXISTS (
              SELECT 1 FROM raw_samples
              WHERE raw_samples.session_id = sessions.session_id
                AND raw_samples.stream = ? AND raw_samples.batch_id IS NULL
            )
            """, [.text(CaptureStream.absoluteAltitude.rawValue)])
    }

    /// Creates batches of at most `maximumSamples` durable, not-yet-batched raw rows, one
    /// transaction per batch: select rows → encode once → insert PENDING item → link rows.
    /// Stops when fewer than `minimumSamples` unbatched rows remain.
    func createTelemetryBatches(sessionID: UUID, maximumSamples: Int, minimumSamples: Int,
                                build: (_ batchID: String, _ rows: [RawRow]) throws -> Data) throws -> [UploadItemRecord] {
        try createTelemetryBatches(sessionID: sessionID, maximumSamples: maximumSamples,
                                   minimumSamples: minimumSamples, includeAbsoluteAltitude: false, build: build)
    }

    func createTelemetryBatches(sessionID: UUID, maximumSamples: Int, minimumSamples: Int,
                                includeAbsoluteAltitude: Bool,
                                build: (_ batchID: String, _ rows: [RawRow]) throws -> Data) throws -> [UploadItemRecord] {
        var created: [UploadItemRecord] = []
        let id = sessionID.uuidString
        while true {
            let item: UploadItemRecord? = try db.transaction {
                try inject(.batchCommit)
                let streamClause = includeAbsoluteAltitude ? "" : " AND stream != ?"
                var values: [SQLiteValue] = [.text(id)]
                if !includeAbsoluteAltitude { values.append(.text(CaptureStream.absoluteAltitude.rawValue)) }
                values.append(.int(maximumSamples))
                let rows = try db.query("""
                    SELECT rowid, stream, sequence, measured_at_ms, payload_json FROM raw_samples
                    WHERE session_id = ? AND batch_id IS NULL\(streamClause) ORDER BY rowid LIMIT ?
                    """, values) { row in
                    (row.int64(0), RawRow(stream: row.text(1) ?? "", sequence: row.int(2),
                                          measuredAtMs: row.int64(3), payload: row.blob(4) ?? Data(), batchID: nil))
                }
                guard !rows.isEmpty, rows.count >= max(1, minimumSamples) else { return nil }
                let batchID = UUID().uuidString
                let payload = try build(batchID, rows.map(\.1))
                let record = try insertItem(sessionID: id, draft: UploadItemDraft(kind: .telemetry, itemID: batchID, payload: payload),
                                            state: .pending, createdAtMs: epochMilliseconds(Date()))
                for (rowID, _) in rows {
                    let changed = try db.run("UPDATE raw_samples SET batch_id = ? WHERE rowid = ? AND batch_id IS NULL",
                                             [.text(batchID), .integer(rowID)])
                    guard changed == 1 else { throw CollectionStoreError.invalidState("raw row linked twice") }
                }
                return record
            }
            guard let item else { break }
            created.append(item)
        }
        return created
    }

    // MARK: Absolute-altitude clock repair

    /// Builds before `AbsoluteAltitudeClock` mapped `CMAbsoluteAltitudeData.timestamp` as boot
    /// uptime, which put those rows ~25 years ahead; the server rejected every batch carrying them
    /// (quarantined, location and motion included). The raw envelope kept the native value and the
    /// callback time, so the measurement time is recomputed, and each pending or quarantined batch
    /// that carries a repaired row is rebuilt from its raw rows and queued again. Rows whose clock
    /// was already right stay untouched. Returns the items that are pending again.
    @discardableResult
    func repairAbsoluteAltitudeClock(
        build: (_ batchID: String, _ sessionID: String, _ rows: [RawRow]) throws -> Data
    ) throws -> [UploadItemRecord] {
        let marker = "%\"clockDomain\":\"\(AbsoluteAltitudeClock.bootUptime)\"%"
        let candidates = try db.query("""
            SELECT rowid, session_id, payload_json, batch_id FROM raw_samples
            WHERE stream = ? AND CAST(payload_json AS TEXT) LIKE ?
            """, [.text(CaptureStream.absoluteAltitude.rawValue), .text(marker)]) { row in
            (rowID: row.int64(0), sessionID: row.text(1) ?? "", payload: row.blob(2) ?? Data(), batchID: row.text(3))
        }
        guard !candidates.isEmpty else { return [] }
        return try db.transaction {
            try inject(.ledgerUpdate)
            var batches: [String: String] = [:]
            for candidate in candidates {
                guard let envelope = try? decoder.decode(RawSampleEnvelope<AbsoluteAltitudeSample>.self, from: candidate.payload),
                      let native = envelope.capture.nativeTimestamp,
                      let resolved = AbsoluteAltitudeClock.resolve(native: native, callbackEpoch: envelope.capture.callbackEpoch,
                                                                   bootMapped: envelope.sample.timestamp),
                      resolved.domain != AbsoluteAltitudeClock.bootUptime else { continue }
                let old = envelope.sample
                let sample = AbsoluteAltitudeSample(
                    id: old.id, sessionId: old.sessionId, sequence: old.sequence, timestamp: resolved.date,
                    altitude: old.altitude, accuracy: old.accuracy, precision: old.precision,
                    verticalReference: old.verticalReference, sensorSegmentId: old.sensorSegmentId,
                    captureSource: old.captureSource, appState: old.appState, invalidReason: old.invalidReason)
                var capture = envelope.capture
                capture.clockDomain = resolved.domain
                try db.run("UPDATE raw_samples SET payload_json = ?, measured_at_ms = ? WHERE rowid = ?",
                           [.blob(try encoder.encode(RawSampleEnvelope(capture: capture, sample: sample))),
                            .integer(epochMilliseconds(resolved.date)), .integer(candidate.rowID)])
                if let batchID = candidate.batchID { batches[batchID] = candidate.sessionID }
            }
            var requeued: [UploadItemRecord] = []
            for (batchID, sessionID) in batches {
                guard let existing = try item(kind: .telemetry, itemID: batchID),
                      existing.state == .pending || existing.state == .quarantined else { continue }
                let rows = try db.query("""
                    SELECT stream, sequence, measured_at_ms, payload_json, batch_id FROM raw_samples
                    WHERE session_id = ? AND batch_id = ? ORDER BY rowid
                    """, [.text(sessionID), .text(batchID)]) { row in
                    RawRow(stream: row.text(0) ?? "", sequence: row.int(1), measuredAtMs: row.int64(2),
                           payload: row.blob(3) ?? Data(), batchID: row.text(4))
                }
                let payload = try build(batchID, sessionID, rows)
                try db.run("""
                    UPDATE upload_items SET payload_json = ?, state = ?, error_json = NULL, restart_retried = 0
                    WHERE kind = ? AND item_id = ?
                    """, [.blob(payload), .text(UploadItemState.pending.rawValue),
                          .text(UploadKind.telemetry.rawValue), .text(batchID)])
                if let updated = try item(kind: .telemetry, itemID: batchID) { requeued.append(updated) }
            }
            return requeued
        }
    }

    // MARK: Stop / finalization

    func persistStopIntent(_ intent: StopIntent, snapshot: ActiveCollectionState) throws {
        try db.transaction {
            try inject(.stopIntent)
            let changed = try db.run("""
                UPDATE sessions SET stop_intent_json = ?, capture_state = ?, snapshot_json = ?
                WHERE session_id = ? AND capture_state IN (?, ?)
                """, [.blob(try encoder.encode(intent)), .text(CaptureState.stopping.rawValue),
                      .blob(try encoder.encode(snapshot)), .text(intent.sessionID.uuidString),
                      .text(CaptureState.recording.rawValue), .text(CaptureState.stopping.rawValue)])
            guard changed == 1 else { throw CollectionStoreError.invalidState("stop intent for non-recording session") }
        }
    }

    /// The single closing transaction: stopped + final manifest + `session:finish` item + snapshot.
    /// Idempotent for a retry of the same Stop (the finish item key is the session id).
    func finalize(sessionID: UUID, manifest: LastSequencesPayload, finish: UploadItemDraft,
                  snapshot: ActiveCollectionState) throws -> UploadItemRecord {
        try db.transaction {
            try inject(.finalize)
            let id = sessionID.uuidString
            let hasIntent = try db.queryOne("SELECT stop_intent_json IS NOT NULL FROM sessions WHERE session_id = ?",
                                            [.text(id)]) { $0.int(0) == 1 }
            guard hasIntent == true else { throw CollectionStoreError.invalidState("finalize without stop intent") }
            try db.run("""
                UPDATE sessions SET capture_state = ?, finalized_manifest_json = ?, snapshot_json = ?
                WHERE session_id = ?
                """, [.text(CaptureState.stopped.rawValue), .blob(try encoder.encode(manifest)),
                      .blob(try encoder.encode(snapshot)), .text(id)])
            return try insertItem(sessionID: id, draft: finish, state: .pending, createdAtMs: epochMilliseconds(Date()))
        }
    }

    // MARK: Upload ledger

    @discardableResult
    func insertItem(sessionID: String, draft: UploadItemDraft, state: UploadItemState,
                    createdAtMs: Int64, error: AckError? = nil, restartRetried: Bool = false) throws -> UploadItemRecord {
        try db.run("""
            INSERT OR IGNORE INTO upload_items (session_id, kind, item_id, state, payload_json, error_json, created_at_ms, restart_retried)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, [.text(sessionID), .text(draft.kind.rawValue), .text(draft.itemID), .text(state.rawValue),
                  .blob(draft.payload), .optionalBlob(try error.map { try encoder.encode($0) }),
                  .integer(createdAtMs), .int(restartRetried ? 1 : 0)])
        guard let record = try item(kind: draft.kind, itemID: draft.itemID) else {
            throw CollectionStoreError.invalidState("upload item missing after insert")
        }
        return record
    }

    func insertUploadItem(sessionID: String, draft: UploadItemDraft) throws -> UploadItemRecord {
        try db.transaction {
            try inject(.uploadInsert)
            return try insertItem(sessionID: sessionID, draft: draft, state: .pending, createdAtMs: epochMilliseconds(Date()))
        }
    }

    func item(kind: UploadKind, itemID: String) throws -> UploadItemRecord? {
        try db.queryOne("""
            SELECT enqueue_order, session_id, kind, item_id, state, payload_json, created_at_ms, restart_retried, error_json
            FROM upload_items WHERE kind = ? AND item_id = ?
            """, [.text(kind.rawValue), .text(itemID)], uploadItem)
    }

    private func uploadItem(_ row: SQLiteRow) throws -> UploadItemRecord {
        guard let kind = row.text(2).flatMap(UploadKind.init(rawValue:)),
              let state = row.text(4).flatMap(UploadItemState.init(rawValue:)) else {
            throw CollectionStoreError.decode("upload_items row")
        }
        return UploadItemRecord(enqueueOrder: row.int64(0), sessionID: row.text(1) ?? "", kind: kind,
                                itemID: row.text(3) ?? "", state: state, payload: row.blob(5) ?? Data(),
                                createdAtMs: row.int64(6), restartRetried: row.int(7) == 1,
                                lastError: try row.blob(8).map { try decoder.decode(AckError.self, from: $0) })
    }

    func loadUploadLedger() throws -> UploadLedgerSnapshot {
        let sessions = try db.query("""
            SELECT session_id, collector_id, server_key, owner_orphaned, start_payload_json, server_session_id,
                   start_quarantined, finish_ack_json, sync_state, capture_state
            FROM sessions WHERE sync_state != ? ORDER BY started_at_ms
            """, [.text(SyncState.complete.rawValue)]) { row -> SessionSyncRecord in
            guard let sync = row.text(8).flatMap(SyncState.init(rawValue:)),
                  let capture = row.text(9).flatMap(CaptureState.init(rawValue:)) else {
                throw CollectionStoreError.decode("session sync row")
            }
            return SessionSyncRecord(
                sessionID: row.text(0) ?? "",
                owner: row.int(3) == 0 ? UploadOwner(collectorId: row.text(1) ?? "", serverKey: row.text(2) ?? "") : nil,
                startPayload: row.blob(4), serverSessionID: row.text(5), startQuarantined: row.int(6) == 1,
                finishAck: try row.blob(7).map { try decoder.decode(LastSequencesPayload.self, from: $0) },
                syncState: sync, captureState: capture)
        }
        let items = try db.query("""
            SELECT enqueue_order, session_id, kind, item_id, state, payload_json, created_at_ms, restart_retried, error_json
            FROM upload_items WHERE state != ? ORDER BY enqueue_order
            """, [.text(UploadItemState.acked.rawValue)], uploadItem)
        return UploadLedgerSnapshot(sessions: sessions, items: items)
    }

    func sessionSync(id: String) throws -> SessionSyncRecord? {
        try loadUploadLedger().sessions.first { $0.sessionID == id }
    }

    /// ACKED rows keep their identity for audit; the payload is dropped because the canonical
    /// raw rows already hold the data.
    func markAcked(_ key: UploadItemKey) throws {
        try db.transaction {
            try inject(.ledgerUpdate)
            let changed = try db.run("""
                UPDATE upload_items SET state = ?, payload_json = X'', error_json = NULL, acked_at_ms = ?
                WHERE kind = ? AND item_id = ? AND state = ?
                """, [.text(UploadItemState.acked.rawValue), .integer(epochMilliseconds(Date())),
                      .text(key.kind.rawValue), .text(key.itemID), .text(UploadItemState.pending.rawValue)])
            guard changed == 1 else { throw CollectionStoreError.invalidState("ack for non-pending item \(key.itemID)") }
        }
    }

    /// Finish ACK + its explanatory follow-up item (e.g. the `SESSION_FINISH_ACK` diagnostic) in
    /// one transaction, so the follow-up is already pending when syncComplete eligibility is checked.
    @discardableResult
    func acknowledgeFinish(sessionID: String, itemID: String, manifest: LastSequencesPayload?,
                           followUp: UploadItemDraft? = nil) throws -> UploadItemRecord? {
        try db.transaction {
            try inject(.ledgerUpdate)
            let changed = try db.run("""
                UPDATE upload_items SET state = ?, acked_at_ms = ? WHERE kind = ? AND item_id = ? AND state = ?
                """, [.text(UploadItemState.acked.rawValue), .integer(epochMilliseconds(Date())),
                      .text(UploadKind.finish.rawValue), .text(itemID), .text(UploadItemState.pending.rawValue)])
            guard changed == 1 else { throw CollectionStoreError.invalidState("finish ack for non-pending item") }
            try db.run("UPDATE sessions SET finish_ack_json = ?, sync_state = ? WHERE session_id = ?",
                       [.optionalBlob(try manifest.map { try encoder.encode($0) }),
                        .text(SyncState.finishAcknowledged.rawValue), .text(sessionID)])
            return try followUp.map { try insertItem(sessionID: sessionID, draft: $0, state: .pending, createdAtMs: epochMilliseconds(Date())) }
        }
    }

    func quarantine(_ key: UploadItemKey, error: AckError) throws {
        try db.transaction {
            try inject(.ledgerUpdate)
            try db.run("UPDATE upload_items SET state = ?, error_json = ? WHERE kind = ? AND item_id = ?",
                       [.text(UploadItemState.quarantined.rawValue), .blob(try encoder.encode(error)),
                        .text(key.kind.rawValue), .text(key.itemID)])
        }
    }

    func recordRetryableError(_ key: UploadItemKey, error: AckError) throws {
        try db.run("UPDATE upload_items SET error_json = ? WHERE kind = ? AND item_id = ?",
                   [.blob(try encoder.encode(error)), .text(key.kind.rawValue), .text(key.itemID)])
    }

    func markRestartRetried(_ key: UploadItemKey, sessionID: String) throws {
        try db.transaction {
            try inject(.ledgerUpdate)
            try db.run("UPDATE upload_items SET restart_retried = 1 WHERE kind = ? AND item_id = ?",
                       [.text(key.kind.rawValue), .text(key.itemID)])
            try db.run("UPDATE sessions SET server_session_id = NULL WHERE session_id = ?", [.text(sessionID)])
        }
    }

    func setServerSessionID(_ serverSessionID: String?, sessionID: String) throws {
        try inject(.ledgerUpdate)
        try db.run("UPDATE sessions SET server_session_id = ?, start_quarantined = 0 WHERE session_id = ?",
                   [.optionalText(serverSessionID), .text(sessionID)])
    }

    func setStartQuarantined(_ quarantined: Bool, sessionID: String?) throws {
        try inject(.ledgerUpdate)
        if let sessionID {
            try db.run("UPDATE sessions SET start_quarantined = ? WHERE session_id = ?",
                       [.int(quarantined ? 1 : 0), .text(sessionID)])
        } else {
            try db.run("UPDATE sessions SET start_quarantined = ?", [.int(quarantined ? 1 : 0)])
        }
    }

    func setSyncState(_ state: SyncState, sessionID: String) throws {
        try inject(.ledgerUpdate)
        try db.run("UPDATE sessions SET sync_state = ? WHERE session_id = ?", [.text(state.rawValue), .text(sessionID)])
    }

    // MARK: ARKit backpressure

    func pendingItemBacklog(sessionID: UUID, kind: UploadKind) throws -> (count: Int, oldestCreatedAtMs: Int64?) {
        try db.queryOne("""
            SELECT COUNT(*), MIN(created_at_ms) FROM upload_items WHERE state = ? AND session_id = ? AND kind = ?
            """, [.text(UploadItemState.pending.rawValue), .text(sessionID.uuidString), .text(kind.rawValue)]) { row in
            (row.int(0), row.isNull(1) ? nil : row.int64(1))
        } ?? (0, nil)
    }

    // MARK: Pedometer dedupe and audit

    func rawPayloads(sessionID: UUID, stream: String) throws -> [Int64: Data] {
        let rows = try db.query("SELECT measured_at_ms, payload_json FROM raw_samples WHERE session_id = ? AND stream = ?",
                                [.text(sessionID.uuidString), .text(stream)]) { ($0.int64(0), $0.blob(1) ?? Data()) }
        return Dictionary(rows, uniquingKeysWith: { first, _ in first })
    }

    func insertAudit(sessionID: UUID, stream: String, reason: String, measuredAtMs: Int64?, payload: Data?) throws {
        try db.run("""
            INSERT INTO capture_audit (session_id, stream, reason, measured_at_ms, payload_json, recorded_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
            """, [.text(sessionID.uuidString), .text(stream), .text(reason),
                  measuredAtMs.map(SQLiteValue.integer) ?? .null, .optionalBlob(payload),
                  .integer(epochMilliseconds(Date()))])
    }

    func auditCount(sessionID: UUID, reason: String) throws -> Int {
        try db.queryOne("SELECT COUNT(*) FROM capture_audit WHERE session_id = ? AND reason = ?",
                        [.text(sessionID.uuidString), .text(reason)]) { $0.int(0) } ?? 0
    }

    // MARK: Raw read / export

    func rawRows(sessionID: UUID, stream: String? = nil) throws -> [RawRow] {
        let sql = stream == nil
            ? "SELECT stream, sequence, measured_at_ms, payload_json, batch_id FROM raw_samples WHERE session_id = ? ORDER BY rowid"
            : "SELECT stream, sequence, measured_at_ms, payload_json, batch_id FROM raw_samples WHERE session_id = ? AND stream = ? ORDER BY sequence"
        var values: [SQLiteValue] = [.text(sessionID.uuidString)]
        if let stream { values.append(.text(stream)) }
        return try db.query(sql, values) { row in
            RawRow(stream: row.text(0) ?? "", sequence: row.int(1), measuredAtMs: row.int64(2),
                   payload: row.blob(3) ?? Data(), batchID: row.text(4))
        }
    }

    /// Writes `<stream>.ndjson` (one stored payload per line, fractional ISO-8601 preserved) and
    /// `metadata.json`. Export failure never touches the canonical rows.
    func exportNDJSON(sessionID: UUID, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var files: [String: Data] = [:]
        for row in try rawRows(sessionID: sessionID) {
            files[row.stream, default: Data()].append(row.payload)
            files[row.stream, default: Data()].append(0x0A)
        }
        for (stream, data) in files {
            try data.write(to: directory.appendingPathComponent("\(stream).ndjson"), options: .atomic)
        }
        if let snapshot = try session(id: sessionID)?.snapshot {
            try encoder.encode(snapshot.session).write(to: directory.appendingPathComponent("metadata.json"), options: .atomic)
        }
    }

    func listCollectionSessions() throws -> [CollectionSession] {
        try sessions(in: [.recording, .stopping, .stopped]).compactMap { $0.snapshot?.session }
    }

    func migrationRows() throws -> [String: String] {
        let rows = try db.query("SELECT source_name, source_sha256 FROM migrations") { ($0.text(0) ?? "", $0.text(1) ?? "") }
        return Dictionary(rows, uniquingKeysWith: { first, _ in first })
    }

    func count(_ table: String) throws -> Int {
        // Table names come only from this file's literals, never from caller data.
        precondition(["sessions", "upload_items", "raw_samples", "sequence_leases", "migrations", "capture_audit"].contains(table))
        return try db.queryOne("SELECT COUNT(*) FROM \(table)") { $0.int(0) } ?? 0
    }
}
