import CryptoKit
import Foundation

// MARK: - Legacy (pre-SQLite) file formats, read-only

nonisolated struct LegacyQueuedArkitPose: Codable, Sendable {
    let clientSessionId: String
    var wire: ArkitPoseWire
    var id: String { wire.itemID }
}

nonisolated struct LegacyQueuedDiagnosticEvent: Codable, Sendable {
    let clientSessionId: String
    let event: DiagnosticEventItem
}

/// The former `pending_uploads.json` layout. Every key is optional on decode so files written by
/// any earlier build still load.
nonisolated struct LegacyUploadQueueState: Codable, Sendable {
    var sessionStarts: [String: SessionStartPayload] = [:]
    var serverSessionIds: [String: String] = [:]
    var sessionOwners: [String: UploadOwner] = [:]
    var telemetry: [TelemetryBatchPayload] = []
    var markers: [MarkerPayload] = []
    var finishes: [FinishPayload] = []
    var finishAcknowledged: [String: LastSequencesPayload] = [:]
    var syncCompleteAcknowledged: Set<String> = []
    var unsynchronizedSessions: Set<String> = []
    var diagnosticEvents: [LegacyQueuedDiagnosticEvent] = []
    var arkitPoses: [LegacyQueuedArkitPose] = []
    var quarantinedSessionStarts: Set<String> = []
    var quarantinedBatchIds: Set<String> = []
    var quarantinedMarkerIds: Set<String> = []
    var quarantinedArkitPoseIds: Set<String> = []
    var quarantinedDiagnosticIds: Set<String> = []
    var quarantinedFinishIds: Set<String> = []
    var quarantinedSyncCompleteIds: Set<String> = []
    var sessionRestartRetried: Set<String> = []
    var lastErrorCodes: [String: String] = [:]

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionStarts = try c.decodeIfPresent([String: SessionStartPayload].self, forKey: .sessionStarts) ?? [:]
        serverSessionIds = try c.decodeIfPresent([String: String].self, forKey: .serverSessionIds) ?? [:]
        sessionOwners = try c.decodeIfPresent([String: UploadOwner].self, forKey: .sessionOwners) ?? [:]
        telemetry = try c.decodeIfPresent([TelemetryBatchPayload].self, forKey: .telemetry) ?? []
        markers = try c.decodeIfPresent([MarkerPayload].self, forKey: .markers) ?? []
        finishes = try c.decodeIfPresent([FinishPayload].self, forKey: .finishes) ?? []
        finishAcknowledged = try c.decodeIfPresent([String: LastSequencesPayload].self, forKey: .finishAcknowledged) ?? [:]
        syncCompleteAcknowledged = try c.decodeIfPresent(Set<String>.self, forKey: .syncCompleteAcknowledged) ?? []
        unsynchronizedSessions = try c.decodeIfPresent(Set<String>.self, forKey: .unsynchronizedSessions) ?? []
        diagnosticEvents = try c.decodeIfPresent([LegacyQueuedDiagnosticEvent].self, forKey: .diagnosticEvents) ?? []
        arkitPoses = try c.decodeIfPresent([LegacyQueuedArkitPose].self, forKey: .arkitPoses) ?? []
        quarantinedSessionStarts = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedSessionStarts) ?? []
        quarantinedBatchIds = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedBatchIds) ?? []
        quarantinedMarkerIds = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedMarkerIds) ?? []
        quarantinedArkitPoseIds = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedArkitPoseIds) ?? []
        quarantinedDiagnosticIds = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedDiagnosticIds) ?? []
        quarantinedFinishIds = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedFinishIds) ?? []
        quarantinedSyncCompleteIds = try c.decodeIfPresent(Set<String>.self, forKey: .quarantinedSyncCompleteIds) ?? []
        sessionRestartRetried = try c.decodeIfPresent(Set<String>.self, forKey: .sessionRestartRetried) ?? []
        lastErrorCodes = try c.decodeIfPresent([String: String].self, forKey: .lastErrorCodes) ?? [:]
    }
}

/// Read-only listing of sessions recorded before the SQLite store (`sessions/<id>/metadata.json`).
/// Their NDJSON files are left untouched; second-level precision lost by old writers is not
/// "restored".
nonisolated enum LegacySessionArchive {
    static func sessionsDirectory(root: URL) -> URL {
        root.appendingPathComponent("sessions", isDirectory: true)
    }

    static func listSessions(root: URL) -> [CollectionSession] {
        let decoder = TrackingJSONCodec.makeDecoder()
        let directories = (try? FileManager.default.contentsOfDirectory(
            at: sessionsDirectory(root: root), includingPropertiesForKeys: nil, options: .skipsHiddenFiles)) ?? []
        return directories.compactMap { url in
            guard let data = try? Data(contentsOf: url.appendingPathComponent("metadata.json")) else { return nil }
            return try? decoder.decode(CollectionSession.self, from: data)
        }
    }
}

// MARK: - Migration

nonisolated struct LegacyMigrationReport: Sendable, Equatable {
    var sources: [String] = []
    var sessions = 0
    var uploadItems = 0
    var rawSamples = 0
    var rawConflicts = 0
    var unreadableRawLines = 0
    var orphanedSessions = 0
}

/// One-time import of the pre-SQLite files. Everything is imported in ONE transaction; the
/// originals are renamed to `*.migrated.backup` only after COMMIT and verification. A crash at
/// any point re-runs safely: unique keys + `migrations(source_sha256)` prevent double import.
nonisolated enum LegacyMigrator {
    static let queueFile = "pending_uploads.json"
    static let activeFile = "active_collection.json"
    static let leaseDirectory = "sequence_leases"
    static let backupSuffix = ".migrated.backup"
    /// Raw rows imported from legacy NDJSON are never re-batched: whether they reached the
    /// server is governed by the legacy upload items that were imported alongside them.
    static let legacyBatchMarker = "LEGACY_PRE_MIGRATION"

    private struct Source {
        let name: String
        let url: URL
        let data: Data
        let sha256: String
    }

    private struct RawIdentity: Decodable {
        let sequence: Int?
        let timestamp: Date?
    }

    static func run(database db: SQLiteDatabase, legacyRoot: URL, now: Date) throws -> LegacyMigrationReport? {
        let fileManager = FileManager.default
        var sources: [Source] = []
        func addSource(name: String, url: URL) throws {
            guard fileManager.fileExists(atPath: url.path) else { return }
            let data = try Data(contentsOf: url)
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            sources.append(Source(name: name, url: url, data: data, sha256: hash))
        }
        try addSource(name: queueFile, url: legacyRoot.appendingPathComponent(queueFile))
        try addSource(name: activeFile, url: legacyRoot.appendingPathComponent(activeFile))
        let leaseRoot = legacyRoot.appendingPathComponent(leaseDirectory, isDirectory: true)
        let leaseFiles = ((try? fileManager.contentsOfDirectory(at: leaseRoot, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
        for file in leaseFiles {
            try addSource(name: "\(leaseDirectory)/\(file.lastPathComponent)", url: file)
        }
        guard !sources.isEmpty else { return nil }

        let imported = try db.query("SELECT source_name, source_sha256 FROM migrations") { ($0.text(0) ?? "", $0.text(1) ?? "") }
        let importedHashes = Dictionary(imported, uniquingKeysWith: { first, _ in first })
        let pending = sources.filter { importedHashes[$0.name] != $0.sha256 }

        var report = LegacyMigrationReport()
        if !pending.isEmpty {
            report = try importSources(pending, db: db, legacyRoot: legacyRoot, now: now)
        }
        // Rename only after a successful COMMIT (or when an earlier run already committed).
        for source in sources {
            let backup = source.url.appendingPathExtension(String(backupSuffix.dropFirst()))
            try? fileManager.removeItem(at: backup)
            do { try fileManager.moveItem(at: source.url, to: backup) }
            catch { print("[Migration] backup rename failed source=\(source.name) error=\(error)") }
        }
        if fileManager.fileExists(atPath: leaseRoot.path),
           ((try? fileManager.contentsOfDirectory(atPath: leaseRoot.path)) ?? []).allSatisfy({ $0.hasSuffix(backupSuffix) }) {
            let backupRoot = legacyRoot.appendingPathComponent(leaseDirectory + backupSuffix, isDirectory: true)
            if !fileManager.fileExists(atPath: backupRoot.path) {
                try? fileManager.moveItem(at: leaseRoot, to: backupRoot)
            }
        }
        return report
    }

    private static func importSources(_ sources: [Source], db: SQLiteDatabase, legacyRoot: URL,
                                      now: Date) throws -> LegacyMigrationReport {
        let decoder = TrackingJSONCodec.makeDecoder()
        let encoder = TrackingJSONCodec.makeEncoder()
        // Decode everything first: any read/decode failure aborts before a single row is written.
        var queue = LegacyUploadQueueState()
        if let source = sources.first(where: { $0.name == queueFile }) {
            do { queue = try decoder.decode(LegacyUploadQueueState.self, from: source.data) }
            catch { throw CollectionStoreError.migration("\(queueFile) decode: \(error)") }
        }
        var active: ActiveCollectionState?
        if let source = sources.first(where: { $0.name == activeFile }) {
            do { active = try decoder.decode(ActiveCollectionState.self, from: source.data) }
            catch { throw CollectionStoreError.migration("\(activeFile) decode: \(error)") }
        }
        var leases: [String: SequenceLease] = [:]
        for source in sources where source.name.hasPrefix(leaseDirectory + "/") {
            let id = source.url.deletingPathExtension().lastPathComponent
            do { leases[id] = try decoder.decode(SequenceLease.self, from: source.data) }
            catch { throw CollectionStoreError.migration("\(source.name) decode: \(error)") }
        }

        var report = LegacyMigrationReport(sources: sources.map(\.name))
        let nowMs = epochMilliseconds(now)
        try db.transaction {
            var sessionIDs = Set(queue.sessionStarts.keys).union(queue.sessionOwners.keys)
                .union(queue.telemetry.map(\.clientSessionId)).union(queue.markers.map(\.clientSessionId))
                .union(queue.finishes.map(\.clientSessionId)).union(queue.diagnosticEvents.map(\.clientSessionId))
                .union(queue.arkitPoses.map(\.clientSessionId)).union(queue.finishAcknowledged.keys)
            if let active { sessionIDs.insert(active.session.id.uuidString) }

            for id in sessionIDs.sorted() {
                let owner = queue.sessionOwners[id]
                if owner == nil { report.orphanedSessions += 1 }
                let isActive = active?.session.id.uuidString == id
                let capture: CaptureState = isActive ? (active?.pendingStop == nil ? .recording : .stopping) : .legacyUploadOnly
                let sync: SyncState
                if queue.syncCompleteAcknowledged.contains(id) { sync = .complete }
                else if queue.unsynchronizedSessions.contains(id) { sync = .incomplete }
                else if queue.quarantinedSyncCompleteIds.contains(id) { sync = .quarantined }
                else if queue.finishAcknowledged[id] != nil { sync = .finishAcknowledged }
                else { sync = .pending }
                let startedAt = active.flatMap { isActive ? $0.session.startedAt : nil }
                    ?? queue.sessionStarts[id]?.startedAt ?? now
                let snapshotData = try (isActive ? active.map { try encoder.encode($0) } : nil) ?? Data("{}".utf8)
                var stopIntent: Data?
                if isActive, let pending = active?.pendingStop, let sessionID = active?.session.id {
                    stopIntent = try encoder.encode(StopIntent(sessionID: sessionID, endedAt: pending.endedAt,
                        reason: pending.reason, interrupted: pending.reason != "user_stop", requestedAt: pending.endedAt))
                }
                try db.run("""
                    INSERT OR IGNORE INTO sessions (session_id, collector_id, server_key, owner_orphaned, capture_state,
                      sync_state, started_at_ms, snapshot_json, stop_intent_json, start_payload_json, server_session_id,
                      start_quarantined, finish_ack_json, legacy_source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, [.text(id), .text(owner?.collectorId ?? ""), .text(owner?.serverKey ?? ""),
                          .int(owner == nil ? 1 : 0), .text(capture.rawValue), .text(sync.rawValue),
                          .integer(epochMilliseconds(startedAt)), .blob(snapshotData), .optionalBlob(stopIntent),
                          .optionalBlob(try queue.sessionStarts[id].map { try encoder.encode($0) }),
                          .optionalText(queue.serverSessionIds[id]),
                          .int(queue.quarantinedSessionStarts.contains(id) ? 1 : 0),
                          .optionalBlob(try queue.finishAcknowledged[id].map { try encoder.encode($0) }),
                          .text("legacy-json")])
                report.sessions += 1
            }

            func insert(_ kind: UploadKind, id: String, session: String, payload: Data, quarantined: Bool) throws {
                let orphan = queue.sessionOwners[session] == nil
                let state: UploadItemState = quarantined ? .quarantined : (orphan ? .heldOrphaned : .pending)
                let error = quarantined || queue.lastErrorCodes[id] != nil
                    ? AckError(code: queue.lastErrorCodes[id] ?? "UNKNOWN", message: "imported from legacy queue",
                               status: nil, retryable: quarantined ? false : true)
                    : nil
                try db.run("""
                    INSERT OR IGNORE INTO upload_items (session_id, kind, item_id, state, payload_json, error_json,
                      created_at_ms, restart_retried)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, [.text(session), .text(kind.rawValue), .text(id), .text(state.rawValue), .blob(payload),
                          .optionalBlob(try error.map { try encoder.encode($0) }), .integer(nowMs),
                          .int(queue.sessionRestartRetried.contains(id) ? 1 : 0)])
                report.uploadItems += 1
            }
            // Legacy arrays are each oldest-first; finishes go last so each session's finish keeps
            // its "after every required item" barrier.
            for batch in queue.telemetry {
                try insert(.telemetry, id: batch.batchId, session: batch.clientSessionId,
                           payload: try encoder.encode(batch), quarantined: queue.quarantinedBatchIds.contains(batch.batchId))
            }
            for marker in queue.markers {
                try insert(.marker, id: marker.markerId, session: marker.clientSessionId,
                           payload: try encoder.encode(marker), quarantined: queue.quarantinedMarkerIds.contains(marker.markerId))
            }
            for pose in queue.arkitPoses {
                try insert(.arkit, id: pose.id, session: pose.clientSessionId,
                           payload: try encoder.encode(pose.wire), quarantined: queue.quarantinedArkitPoseIds.contains(pose.id))
            }
            for event in queue.diagnosticEvents {
                try insert(.diagnostic, id: event.event.eventId, session: event.clientSessionId,
                           payload: try encoder.encode(event.event), quarantined: queue.quarantinedDiagnosticIds.contains(event.event.eventId))
            }
            for finish in queue.finishes {
                try insert(.finish, id: finish.clientSessionId, session: finish.clientSessionId,
                           payload: try encoder.encode(finish), quarantined: queue.quarantinedFinishIds.contains(finish.clientSessionId))
            }

            if let active {
                try importActiveRaw(active, queue: queue, lease: leases[active.session.id.uuidString],
                                    db: db, legacyRoot: legacyRoot, report: &report, nowMs: nowMs)
            }

            // Verify inside the transaction so a mismatch rolls everything back.
            let expectedItems = queue.telemetry.count + queue.markers.count + queue.arkitPoses.count
                + queue.diagnosticEvents.count + queue.finishes.count
            let importedItems = try db.queryOne("SELECT COUNT(*) FROM upload_items") { $0.int(0) } ?? 0
            guard importedItems >= expectedItems else {
                throw CollectionStoreError.migration("upload item count \(importedItems) < \(expectedItems)")
            }
            let quarantinedExpected = queue.quarantinedBatchIds.count + queue.quarantinedMarkerIds.count
                + queue.quarantinedArkitPoseIds.count + queue.quarantinedDiagnosticIds.count + queue.quarantinedFinishIds.count
            let quarantinedImported = try db.queryOne("SELECT COUNT(*) FROM upload_items WHERE state = ?",
                                                      [.text(UploadItemState.quarantined.rawValue)]) { $0.int(0) } ?? 0
            guard quarantinedImported >= min(quarantinedExpected, expectedItems) else {
                throw CollectionStoreError.migration("quarantine count mismatch")
            }
            for source in sources {
                try db.run("INSERT OR REPLACE INTO migrations (source_name, source_sha256, imported_at_ms) VALUES (?, ?, ?)",
                           [.text(source.name), .text(source.sha256), .integer(nowMs)])
            }
        }
        print("[Migration] imported sources=\(report.sources) sessions=\(report.sessions) items=\(report.uploadItems) raw=\(report.rawSamples) conflicts=\(report.rawConflicts) orphaned=\(report.orphanedSessions)")
        return report
    }

    /// Imports the interrupted session's NDJSON rows so the session stays one canonical record
    /// after Resume. Rows contained in a still-pending legacy batch keep that batch id; all other
    /// rows are linked to `legacyBatchMarker` (their upload fate is unknown: they may already
    /// have been ACKed and removed from the queue). Legacy leases/snapshot sequences only ever
    /// raise the durable boundary.
    private static func importActiveRaw(_ active: ActiveCollectionState, queue: LegacyUploadQueueState,
                                        lease: SequenceLease?, db: SQLiteDatabase, legacyRoot: URL,
                                        report: inout LegacyMigrationReport, nowMs: Int64) throws {
        let decoder = TrackingJSONCodec.makeDecoder()
        let id = active.session.id.uuidString
        var batchOf: [String: String] = [:]
        for batch in queue.telemetry where batch.clientSessionId == id {
            for value in batch.locations { batchOf["location#\(value.sequence)"] = batch.batchId }
            for value in batch.motion { batchOf["motion#\(value.sequence)"] = batch.batchId }
            for value in batch.altimeter { batchOf["altimeter#\(value.sequence)"] = batch.batchId }
            for value in batch.pedometer { batchOf["pedometer#\(value.sequence)"] = batch.batchId }
        }
        let directory = LegacySessionArchive.sessionsDirectory(root: legacyRoot).appendingPathComponent(id, isDirectory: true)
        var durable: [String: (last: Int, count: Int)] = [:]
        for stream in ["location", "motion", "altimeter", "pedometer", "marker"] {
            let url = directory.appendingPathComponent("\(stream).ndjson")
            guard let data = try? Data(contentsOf: url) else { continue }
            var markerIndex = 0
            for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
                let payload = Data(line)
                guard let identity = try? decoder.decode(RawIdentity.self, from: payload), let timestamp = identity.timestamp else {
                    // Typically a torn final line from a crash mid-append. Preserve the bytes.
                    report.unreadableRawLines += 1
                    try db.run("""
                        INSERT INTO capture_audit (session_id, stream, reason, measured_at_ms, payload_json, recorded_at_ms)
                        VALUES (?, ?, 'LEGACY_NDJSON_UNREADABLE_LINE', NULL, ?, ?)
                        """, [.text(id), .text(stream), .blob(payload), .integer(nowMs)])
                    continue
                }
                markerIndex += 1
                let sequence = identity.sequence ?? markerIndex
                let batch = batchOf["\(stream)#\(sequence)"] ?? legacyBatchMarker
                let changed = try db.run("""
                    INSERT OR IGNORE INTO raw_samples (session_id, stream, sequence, measured_at_ms, payload_json, batch_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """, [.text(id), .text(stream), .int(sequence), .integer(epochMilliseconds(timestamp)),
                          .blob(payload), .text(batch)])
                if changed == 0 {
                    let existing = try db.queryOne("SELECT payload_json FROM raw_samples WHERE session_id = ? AND stream = ? AND sequence = ?",
                                                   [.text(id), .text(stream), .int(sequence)]) { $0.blob(0) }
                    if existing != payload {
                        report.rawConflicts += 1
                        try db.run("""
                            INSERT INTO capture_audit (session_id, stream, reason, measured_at_ms, payload_json, recorded_at_ms)
                            VALUES (?, ?, 'LEGACY_RAW_CONFLICT', ?, ?, ?)
                            """, [.text(id), .text(stream), .integer(epochMilliseconds(timestamp)), .blob(payload), .integer(nowMs)])
                    }
                    continue
                }
                report.rawSamples += 1
                let previous = durable[stream] ?? (-1, 0)
                durable[stream] = (max(previous.last, sequence), previous.count + 1)
            }
        }
        let counts = active.session.sampleCounts
        let streams: [(String, Int, Int, Int)] = [
            ("location", active.locationSequence, lease?.location ?? 0, counts.location),
            ("motion", active.motionSequence, lease?.motion ?? 0, counts.motion),
            ("altimeter", active.altimeterSequence, lease?.altimeter ?? 0, counts.altimeter),
            ("pedometer", active.pedometerSequence, lease?.pedometer ?? 0, counts.pedometer),
            ("marker", durable["marker"]?.last ?? 0, 0, counts.marker),
        ]
        for (stream, snapshotSequence, leaseBoundary, snapshotCount) in streams {
            let raw = durable[stream] ?? (-1, 0)
            // Samples issued before the crash may have been uploaded without reaching NDJSON, so
            // the manifest keeps the snapshot's issued sequence as a floor.
            let last = max(raw.last, snapshotSequence > 0 ? snapshotSequence : -1)
            let count = max(raw.count, snapshotCount)
            try db.run("""
                INSERT INTO sequence_leases (session_id, stream, reserved_exclusive, last_recorded, recorded_count)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id, stream) DO UPDATE SET
                  reserved_exclusive = MAX(reserved_exclusive, excluded.reserved_exclusive),
                  last_recorded = MAX(last_recorded, excluded.last_recorded),
                  recorded_count = MAX(recorded_count, excluded.recorded_count)
                """, [.text(id), .text(stream), .int(max(leaseBoundary, last + 1)), .int(last), .int(count)])
        }
    }
}
