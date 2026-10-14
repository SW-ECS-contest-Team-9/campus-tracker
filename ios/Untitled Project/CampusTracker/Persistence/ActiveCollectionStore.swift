import Foundation

enum CollectorAppState: String, Codable {
    case foreground
    case background
    case inactive
}

struct SensorGapSummary: Codable {
    var count = 0
    var maximumMilliseconds = 0.0

    mutating func record(previous: Date?, current: Date, expectedInterval: TimeInterval) {
        guard let previous else { return }
        let gap = current.timeIntervalSince(previous)
        guard gap > max(expectedInterval * 3, 1) else { return }
        count += 1
        maximumMilliseconds = max(maximumMilliseconds, gap * 1_000)
    }
}

struct CollectionDiagnostics: Codable {
    var foregroundDuration: TimeInterval = 0
    var backgroundDuration: TimeInterval = 0
    var backgroundTransitionCount = 0
    var locationGaps = SensorGapSummary()
    var motionGaps = SensorGapSummary()
    var altimeterGaps = SensorGapSummary()
    var pedometerGaps = SensorGapSummary()
    var pendingUploadPeakCount = 0
    var lowPowerModeObserved = false
    var thermalStatePeak = 0
    var wasInterrupted = false
}

struct ActiveCollectionState: Codable {
    var session: CollectionSession
    var motionRate: MotionSamplingRate
    var locationProfile: LocationCollectionProfile
    var distanceFilter: Double
    var locationSequence: Int
    var motionSequence: Int
    var altimeterSequence: Int
    var pedometerSequence: Int
    var lastPersistedAt: Date
    var lastLocationTimestamp: Date?
    var lastMotionTimestamp: Date?
    var lastAltimeterTimestamp: Date?
    var lastPedometerTimestamp: Date?
    var diagnostics: CollectionDiagnostics
}

final class ActiveCollectionStore {
    private let url: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let queue = DispatchQueue(label: "CampusTracker.active-collection", qos: .utility)
    private var pendingSave: DispatchWorkItem?

    init(fileManager: FileManager = .default) {
        let support = (try? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? fileManager.temporaryDirectory
        let directory = support.appendingPathComponent("CampusCollector", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("active_collection.json")
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    func load() -> ActiveCollectionState? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try decoder.decode(ActiveCollectionState.self, from: data)
        } catch {
            print("[CollectionState] restore failed error=\(String(reflecting: error))")
            return nil
        }
    }

    func save(_ state: ActiveCollectionState, immediately: Bool = false) {
        pendingSave?.cancel()
        let work = DispatchWorkItem { [url, encoder] in
            do {
                let data = try encoder.encode(state)
                try data.write(to: url, options: .atomic)
            } catch {
                print("[CollectionState] save failed error=\(String(reflecting: error))")
            }
        }
        pendingSave = work
        if immediately {
            queue.sync(execute: work)
        } else {
            queue.asyncAfter(deadline: .now() + 0.25, execute: work)
        }
    }

    func clear() {
        pendingSave?.cancel()
        pendingSave = nil
        queue.async { [url] in
            try? FileManager.default.removeItem(at: url)
        }
    }
}

/// Durable high-water mark per sensor stream, separate from `ActiveCollectionState` (which is
/// debounced to disk every ~1s and so can lose the last second of sequence advances on a crash).
/// `ensureLeased` writes synchronously, but only once per `leaseBlockSize` sequences, so a crash
/// can never cause a *resumed* session to reuse a sequence number an earlier process already
/// issued — it can only skip ahead by up to one block.
struct SequenceLease: Codable {
    var location = 0
    var motion = 0
    var altimeter = 0
    var pedometer = 0
}

final class SequenceLeaseStore {
    private let leaseBlockSize: Int
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// `directoryOverride` exists so tests can point this at an isolated temporary directory
    /// instead of the app's real Application Support folder.
    init(fileManager: FileManager = .default, leaseBlockSize: Int = 200, directoryOverride: URL? = nil) {
        self.leaseBlockSize = leaseBlockSize
        if let directoryOverride {
            directory = directoryOverride
        } else {
            let support = (try? fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )) ?? fileManager.temporaryDirectory
            directory = support.appendingPathComponent("CampusCollector", isDirectory: true).appendingPathComponent("sequence_leases", isDirectory: true)
        }
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func url(for sessionId: UUID) -> URL { directory.appendingPathComponent("\(sessionId.uuidString).json") }

    func load(sessionId: UUID) -> SequenceLease {
        guard let data = try? Data(contentsOf: url(for: sessionId)),
              let lease = try? decoder.decode(SequenceLease.self, from: data) else {
            return SequenceLease()
        }
        return lease
    }

    /// Call with the sequence number about to be issued for `stream`, before using it. Advances
    /// and durably persists the lease boundary the moment the counter would reach it.
    func ensureLeased(sessionId: UUID, stream: WritableKeyPath<SequenceLease, Int>, nextSequence: Int) {
        var lease = load(sessionId: sessionId)
        guard nextSequence >= lease[keyPath: stream] else { return }
        lease[keyPath: stream] = nextSequence + leaseBlockSize
        guard let data = try? encoder.encode(lease) else { return }
        try? data.write(to: url(for: sessionId), options: .atomic)
    }

    func clear(sessionId: UUID) {
        try? FileManager.default.removeItem(at: url(for: sessionId))
    }
}
