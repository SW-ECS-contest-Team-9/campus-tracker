import Foundation

protocol SensorDataRepository: AnyObject {
    func create(session: CollectionSession)
    func resume(session: CollectionSession)
    func update(session: CollectionSession)
    func append(location: LocationSample)
    func append(motion: MotionSample)
    func append(altimeter: AltimeterSample)
    func append(pedometer: PedometerSample)
    func append(marker: EventMarker)
    func finish(session: CollectionSession, completion: @escaping () -> Void)
    func loadSessions(completion: @escaping ([CollectionSession]) -> Void)
}

final class LocalSensorDataRepository: SensorDataRepository {
    private enum Stream: String {
        case location, motion, altimeter, pedometer, marker
    }

    private let queue = DispatchQueue(label: "CampusCollector.repository", qos: .utility)
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let rootURL: URL
    private var buffers: [UUID: [Stream: [Data]]] = [:]
    private var counts: [UUID: SampleCounts] = [:]
    private var sessions: [UUID: CollectionSession] = [:]
    private var lastFlush: [UUID: Date] = [:]

    init(fileManager: FileManager = .default) {
        encoder = JSONEncoder()
        decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        let applicationSupport = try? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        rootURL = (applicationSupport ?? fileManager.temporaryDirectory)
            .appendingPathComponent("CampusCollector", isDirectory: true)
            .appendingPathComponent("sessions", isDirectory: true)
        try? fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    func create(session: CollectionSession) {
        queue.async {
            self.sessions[session.id] = session
            self.counts[session.id] = session.sampleCounts
            self.buffers[session.id] = [:]
            self.lastFlush[session.id] = Date()
            let directory = self.directory(for: session.id)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            self.writeMetadata(session)
        }
    }

    func resume(session: CollectionSession) {
        queue.async {
            self.sessions[session.id] = session
            self.counts[session.id] = session.sampleCounts
            self.buffers[session.id] = [:]
            self.lastFlush[session.id] = Date()
            let directory = self.directory(for: session.id)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            self.writeMetadata(session)
        }
    }

    func update(session: CollectionSession) {
        queue.async {
            if self.sessions[session.id] != nil {
                self.sessions[session.id] = session
            }
            self.writeMetadata(session)
        }
    }

    func append(location: LocationSample) { append(location, to: .location, sessionId: location.sessionId) }
    func append(motion: MotionSample) { append(motion, to: .motion, sessionId: motion.sessionId) }
    func append(altimeter: AltimeterSample) { append(altimeter, to: .altimeter, sessionId: altimeter.sessionId) }
    func append(pedometer: PedometerSample) { append(pedometer, to: .pedometer, sessionId: pedometer.sessionId) }
    func append(marker: EventMarker) { append(marker, to: .marker, sessionId: marker.sessionId) }

    func finish(session: CollectionSession, completion: @escaping () -> Void) {
        queue.async {
            self.flush(sessionId: session.id)
            var completed = session
            completed.sampleCounts = self.counts[session.id] ?? session.sampleCounts
            self.writeMetadata(completed)
            self.sessions.removeValue(forKey: session.id)
            self.counts.removeValue(forKey: session.id)
            self.buffers.removeValue(forKey: session.id)
            self.lastFlush.removeValue(forKey: session.id)
            DispatchQueue.main.async(execute: completion)
        }
    }

    func loadSessions(completion: @escaping ([CollectionSession]) -> Void) {
        queue.async {
            let directories = (try? FileManager.default.contentsOfDirectory(
                at: self.rootURL,
                includingPropertiesForKeys: nil,
                options: .skipsHiddenFiles
            )) ?? []
            let loaded = directories.compactMap { url -> CollectionSession? in
                guard let data = try? Data(contentsOf: url.appendingPathComponent("metadata.json")) else { return nil }
                return try? self.decoder.decode(CollectionSession.self, from: data)
            }.sorted { $0.startedAt > $1.startedAt }
            DispatchQueue.main.async { completion(loaded) }
        }
    }

    private func append<T: Encodable>(_ sample: T, to stream: Stream, sessionId: UUID) {
        queue.async {
            guard self.sessions[sessionId] != nil, let data = try? self.encoder.encode(sample) else { return }
            self.buffers[sessionId, default: [:]][stream, default: []].append(data)
            self.incrementCount(for: stream, sessionId: sessionId)
            if (self.buffers[sessionId]?[stream]?.count ?? 0) >= 32 ||
                Date().timeIntervalSince(self.lastFlush[sessionId] ?? .distantPast) >= 2 {
                self.flush(sessionId: sessionId)
            }
        }
    }

    private func flush(sessionId: UUID) {
        guard let streamBuffers = buffers[sessionId] else { return }
        for (stream, records) in streamBuffers where !records.isEmpty {
            let url = directory(for: sessionId).appendingPathComponent("\(stream.rawValue).ndjson")
            let payload = records.reduce(into: Data()) { result, record in
                result.append(record)
                result.append(0x0A)
            }
            if FileManager.default.fileExists(atPath: url.path),
               let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: payload)
                try? handle.synchronize()
            } else {
                try? payload.write(to: url, options: .atomic)
            }
            buffers[sessionId]?[stream] = []
        }
        lastFlush[sessionId] = Date()
        if var session = sessions[sessionId] {
            session.sampleCounts = counts[sessionId] ?? session.sampleCounts
            sessions[sessionId] = session
            writeMetadata(session)
        }
    }

    private func incrementCount(for stream: Stream, sessionId: UUID) {
        var value = counts[sessionId] ?? SampleCounts()
        switch stream {
        case .location: value.location += 1
        case .motion: value.motion += 1
        case .altimeter: value.altimeter += 1
        case .pedometer: value.pedometer += 1
        case .marker: value.marker += 1
        }
        counts[sessionId] = value
    }

    private func directory(for sessionId: UUID) -> URL {
        rootURL.appendingPathComponent(sessionId.uuidString, isDirectory: true)
    }

    private func writeMetadata(_ session: CollectionSession) {
        guard let data = try? encoder.encode(session) else { return }
        try? data.write(to: directory(for: session.id).appendingPathComponent("metadata.json"), options: .atomic)
    }
}
