import Foundation

nonisolated enum TrackingInfrastructureError: Error {
    case invalidClockAnchor
    case invalidTimestamp
    case invalidSamplingRate
    case captureAlreadyOpen
    case staleCaptureContext
}

nonisolated struct TrackingClockAnchor: Codable, Equatable, Sendable {
    let epochAtAnchor: Date
    let uptimeAtAnchor: TimeInterval
    let verifiedOffsetSeconds: TimeInterval
    let mappingVersion: Int

    init(epochAtAnchor: Date, uptimeAtAnchor: TimeInterval,
         verifiedOffsetSeconds: TimeInterval = 0, mappingVersion: Int = 1) throws {
        guard epochAtAnchor.timeIntervalSince1970.isFinite, uptimeAtAnchor.isFinite,
              uptimeAtAnchor >= 0, verifiedOffsetSeconds.isFinite else {
            throw TrackingInfrastructureError.invalidClockAnchor
        }
        self.epochAtAnchor = epochAtAnchor
        self.uptimeAtAnchor = uptimeAtAnchor
        self.verifiedOffsetSeconds = verifiedOffsetSeconds
        self.mappingVersion = mappingVersion
    }

    static func captureNominal() throws -> Self {
        let before = ProcessInfo.processInfo.systemUptime
        let epoch = Date()
        let after = ProcessInfo.processInfo.systemUptime
        return try Self(epochAtAnchor: epoch, uptimeAtAnchor: (before + after) / 2)
    }

    func map(nativeTimestamp: TimeInterval) throws -> Date {
        guard nativeTimestamp.isFinite, nativeTimestamp >= 0 else {
            throw TrackingInfrastructureError.invalidTimestamp
        }
        return epochAtAnchor.addingTimeInterval(nativeTimestamp - uptimeAtAnchor + verifiedOffsetSeconds)
    }

    func mapDerived(nativeTimestamp: TimeInterval, owningNativeTimestamp: TimeInterval,
                    owningMeasuredAt: Date) throws -> Date {
        guard nativeTimestamp.isFinite, owningNativeTimestamp.isFinite,
              owningMeasuredAt.timeIntervalSince1970.isFinite else {
            throw TrackingInfrastructureError.invalidTimestamp
        }
        return owningMeasuredAt.addingTimeInterval(nativeTimestamp - owningNativeTimestamp)
    }

    func deliveryResidual(nativeTimestamp: TimeInterval, callbackEpoch: Date) throws -> TimeInterval {
        callbackEpoch.timeIntervalSince(try map(nativeTimestamp: nativeTimestamp))
    }
}

nonisolated enum TrackingJSONCodec {
    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }

    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let value = formatter.date(from: text) { return value }
            formatter.formatOptions = [.withInternetDateTime]
            if let value = formatter.date(from: text) { return value }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 date")
        }
        return decoder
    }
}

nonisolated struct TrackingCaptureContext: Codable, Equatable, Sendable {
    let sessionID: UUID
    let streamSegmentID: UUID
    let generation: UUID
}

nonisolated struct TrackingAdmission: Sendable {
    let context: TrackingCaptureContext
    let ordinal: UInt64
}

nonisolated struct TrackingStopBoundary: Sendable {
    let context: TrackingCaptureContext
    let lastAdmissionOrdinal: UInt64
    let cutoffUptime: TimeInterval
}

nonisolated final class TrackingCaptureIngress: @unchecked Sendable {
    private let lock = NSLock()
    private let processorQueue: DispatchQueue
    private var active: TrackingCaptureContext?
    private var ordinal: UInt64 = 0

    init(processorQueue: DispatchQueue) { self.processorQueue = processorQueue }

    func open(_ context: TrackingCaptureContext) throws {
        lock.lock(); defer { lock.unlock() }
        guard active == nil else { throw TrackingInfrastructureError.captureAlreadyOpen }
        active = context
        ordinal = 0
    }

    @discardableResult
    func submit(context: TrackingCaptureContext,
                process: @escaping @Sendable (TrackingAdmission) -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active == context, ordinal < UInt64.max else { return false }
        ordinal += 1
        let admission = TrackingAdmission(context: context, ordinal: ordinal)
        processorQueue.async { process(admission) }
        return true
    }

    func close(context: TrackingCaptureContext,
               onDrained: @escaping @Sendable (TrackingStopBoundary) -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard active == context else { throw TrackingInfrastructureError.staleCaptureContext }
        let boundary = TrackingStopBoundary(context: context, lastAdmissionOrdinal: ordinal,
                                            cutoffUptime: ProcessInfo.processInfo.systemUptime)
        active = nil
        processorQueue.async { onDrained(boundary) }
    }
}

nonisolated struct TrackingWindowEligibility: Equatable, Sendable {
    let eligible: Bool
    let spanSeconds: TimeInterval
    let uniqueOriginalSamples: Int
    let occupiedSlotCoverage: Double
    let maximumGapSeconds: TimeInterval
}

nonisolated struct TrackingRatePolicy: Sendable {
    let nominalHz: Int
    var minimumSpanSeconds: TimeInterval = 1.5
    var minimumCoverage = 0.8
    var maximumGapSeconds: TimeInterval = 0.25

    init(nominalHz: Int) throws {
        guard [10, 20, 50].contains(nominalHz) else {
            throw TrackingInfrastructureError.invalidSamplingRate
        }
        self.nominalHz = nominalHz
    }

    func evaluate(originalTimestamps: [TimeInterval]) -> TrackingWindowEligibility {
        let empty = TrackingWindowEligibility(eligible: false, spanSeconds: 0,
            uniqueOriginalSamples: 0, occupiedSlotCoverage: 0, maximumGapSeconds: 0)
        guard originalTimestamps.count >= 2, originalTimestamps.allSatisfy(\.isFinite),
              let first = originalTimestamps.first, let last = originalTimestamps.last else { return empty }
        var maximumGap = 0.0
        for index in 1..<originalTimestamps.count {
            let gap = originalTimestamps[index] - originalTimestamps[index - 1]
            guard gap > 0 else { return empty }
            maximumGap = max(maximumGap, gap)
        }
        let span = last - first
        guard span > 0, span <= 10 else { return empty }
        let expectedSlots = max(1, Int((span * Double(nominalHz)).rounded()) + 1)
        let occupiedSlots = Set(originalTimestamps.map {
            Int((($0 - first) * Double(nominalHz)).rounded())
        }).count
        let coverage = min(1, Double(occupiedSlots) / Double(expectedSlots))
        let minimumCount = max(12, Int(ceil(Double(nominalHz) * minimumSpanSeconds * minimumCoverage)))
        return TrackingWindowEligibility(eligible: span >= minimumSpanSeconds
            && originalTimestamps.count >= minimumCount && coverage >= minimumCoverage
            && maximumGap <= maximumGapSeconds, spanSeconds: span,
            uniqueOriginalSamples: originalTimestamps.count, occupiedSlotCoverage: coverage,
            maximumGapSeconds: maximumGap)
    }
}
