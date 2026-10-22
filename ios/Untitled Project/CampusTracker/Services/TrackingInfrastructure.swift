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

/// `CMAbsoluteAltitudeData.timestamp` is not on the boot-uptime clock the other Core Motion items
/// use: devices report values such as 7.3e8 s, seconds since 2001-01-01 (Date's reference date).
/// Mapped as uptime that becomes a time ~25 years ahead, which the server rejects for the whole
/// batch. Each plausible clock is tried; the one consistent with the callback time wins.
nonisolated enum AbsoluteAltitudeClock {
    struct Resolution: Equatable, Sendable {
        let date: Date
        let domain: String
    }

    static let bootUptime = "BOOT_UPTIME"
    static let referenceDate = "REFERENCE_DATE"
    static let unixEpoch = "UNIX_EPOCH"
    /// A measurement is delivered after it was taken (Core Motion holds altitude for seconds,
    /// a suspended app for longer), never noticeably before.
    static let maximumDeliveryDelaySeconds: TimeInterval = 3600
    static let maximumLeadSeconds: TimeInterval = 5

    /// `bootMapped` is the uptime-anchor mapping of `native` (nil when it could not be mapped).
    /// Nil when no clock places the measurement near its callback.
    static func resolve(native: TimeInterval, callbackEpoch: Date, bootMapped: Date?) -> Resolution? {
        guard native.isFinite, native >= 0 else { return nil }
        var candidates: [Resolution] = []
        if let bootMapped { candidates.append(Resolution(date: bootMapped, domain: bootUptime)) }
        candidates.append(Resolution(date: Date(timeIntervalSinceReferenceDate: native), domain: referenceDate))
        candidates.append(Resolution(date: Date(timeIntervalSince1970: native), domain: unixEpoch))
        let plausible = candidates.filter { candidate in
            let delay = callbackEpoch.timeIntervalSince(candidate.date)
            return delay >= -maximumLeadSeconds && delay <= maximumDeliveryDelaySeconds
        }
        return plausible.min { abs(callbackEpoch.timeIntervalSince($0.date)) < abs(callbackEpoch.timeIntervalSince($1.date)) }
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

    /// Closes whatever context is open (if any). The drain barrier is enqueued under the same lock
    /// as admissions, so it runs after every callback admitted before this call.
    @discardableResult
    func closeIfOpen(onDrained: @escaping @Sendable (TrackingStopBoundary) -> Void) -> TrackingCaptureContext? {
        lock.lock(); defer { lock.unlock() }
        guard let context = active else { return nil }
        let boundary = TrackingStopBoundary(context: context, lastAdmissionOrdinal: ordinal,
                                            cutoffUptime: ProcessInfo.processInfo.systemUptime)
        active = nil
        processorQueue.async { onDrained(boundary) }
        return context
    }

    var openContext: TrackingCaptureContext? {
        lock.lock(); defer { lock.unlock() }
        return active
    }
}

/// Lock-protected per-stream counters for callbacks rejected at the ingress (closed or previous
/// generation). They are never attributed to a new session; only counted.
nonisolated final class CaptureDropCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    func increment(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        counts[key, default: 0] += 1
    }

    func snapshot() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        return counts
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        counts.removeAll()
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
