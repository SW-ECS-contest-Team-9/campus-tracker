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
