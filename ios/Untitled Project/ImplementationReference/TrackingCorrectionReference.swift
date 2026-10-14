import Foundation

// Reference implementation outside the app target. Integrate through the accompanying
// IOS_TRACKING_IMPLEMENTATION_XCODE.md; this file does not start sensors or send data.

nonisolated enum TrackingReferenceError: Error {
    case invalidClockAnchor
    case invalidTimestamp
    case invalidSamplingRate
    case invalidSequenceState
    case sequenceOverflow
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
        guard epochAtAnchor.timeIntervalSince1970.isFinite,
              uptimeAtAnchor.isFinite, uptimeAtAnchor >= 0,
              verifiedOffsetSeconds.isFinite else {
            throw TrackingReferenceError.invalidClockAnchor
        }
        self.epochAtAnchor = epochAtAnchor
        self.uptimeAtAnchor = uptimeAtAnchor
        self.verifiedOffsetSeconds = verifiedOffsetSeconds
        self.mappingVersion = mappingVersion
    }

    // Capture on the sensor execution context before starting the stream. This nominal
    // mapping assumes the native timestamp has the same boot-relative domain as uptime.
    // Large delivery residuals are evidence to inspect, never an automatic offset.
    static func captureNominal() throws -> Self {
        let before = ProcessInfo.processInfo.systemUptime
        let epoch = Date()
        let after = ProcessInfo.processInfo.systemUptime
        return try Self(epochAtAnchor: epoch, uptimeAtAnchor: (before + after) / 2)
    }

    func map(nativeTimestamp: TimeInterval) throws -> Date {
        guard nativeTimestamp.isFinite, nativeTimestamp >= 0 else {
            throw TrackingReferenceError.invalidTimestamp
        }
        return epochAtAnchor.addingTimeInterval(
            nativeTimestamp - uptimeAtAnchor + verifiedOffsetSeconds
        )
    }

    func mapDerived(nativeTimestamp: TimeInterval,
                    owningNativeTimestamp: TimeInterval,
                    owningMeasuredAt: Date) throws -> Date {
        guard nativeTimestamp.isFinite, owningNativeTimestamp.isFinite,
              owningMeasuredAt.timeIntervalSince1970.isFinite else {
            throw TrackingReferenceError.invalidTimestamp
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
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: text) { return date }
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

// Lock protects only context/ordinal and queue submission. No sensor, file or UI work
// runs under the lock. All admitted work and the stop barrier run on one supplied queue.
// @unchecked Sendable is justified by that lock; callers must use immutable Sendable DTOs.
nonisolated final class TrackingCaptureIngress: @unchecked Sendable {
    private let lock = NSLock()
    private let processorQueue: DispatchQueue
    private var active: TrackingCaptureContext?
    private var ordinal: UInt64 = 0

    init(processorQueue: DispatchQueue) {
        self.processorQueue = processorQueue
    }

    func open(_ context: TrackingCaptureContext) throws {
        lock.lock()
        defer { lock.unlock() }
        guard active == nil else { throw TrackingReferenceError.captureAlreadyOpen }
        active = context
        ordinal = 0
    }

    @discardableResult
    func submit(context: TrackingCaptureContext,
                process: @escaping @Sendable (TrackingAdmission) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard active == context, ordinal < UInt64.max else { return false }
        ordinal += 1
        let admission = TrackingAdmission(context: context, ordinal: ordinal)
        // Enqueue while still under the admission lock: a different callback cannot
        // acquire ordinal N+1 and enqueue it before ordinal N.
        processorQueue.async { process(admission) }
        return true
    }

    func close(context: TrackingCaptureContext,
               onDrained: @escaping @Sendable (TrackingStopBoundary) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        guard active == context else { throw TrackingReferenceError.staleCaptureContext }
        let boundary = TrackingStopBoundary(context: context,
            lastAdmissionOrdinal: ordinal, cutoffUptime: ProcessInfo.processInfo.systemUptime)
        active = nil
        processorQueue.async { onDrained(boundary) }
    }
}

// Confined to the processor/storage executor, not shared between tasks. The stored
// exclusive limit is the first unreserved sequence. Existing lease values migrate
// conservatively to this meaning; skipped IDs do not count as recorded samples.
nonisolated struct TrackingSequenceAllocator {
    private(set) var lastIssued: Int
    private(set) var reservedExclusive: Int
    let blockSize: Int

    init(snapshotLastIssued: Int, durableLastRecorded: Int,
         reservedExclusive: Int, blockSize: Int = 200) throws {
        guard snapshotLastIssued >= 0, durableLastRecorded >= -1,
              reservedExclusive >= 0, blockSize > 0 else {
            throw TrackingReferenceError.invalidSequenceState
        }
        self.lastIssued = max(snapshotLastIssued, durableLastRecorded, max(0, reservedExclusive - 1))
        self.reservedExclusive = reservedExclusive
        self.blockSize = blockSize
    }

    mutating func issue(persistExclusiveLimit: (Int) throws -> Void) throws -> Int {
        let (candidate, overflow) = lastIssued.addingReportingOverflow(1)
        guard !overflow else { throw TrackingReferenceError.sequenceOverflow }
        if candidate >= reservedExclusive {
            let (newLimit, limitOverflow) = candidate.addingReportingOverflow(blockSize)
            guard !limitOverflow else { throw TrackingReferenceError.sequenceOverflow }
            try persistExclusiveLimit(newLimit) // failure leaves allocator state unchanged
            reservedExclusive = newLimit
        }
        lastIssued = candidate
        return candidate
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
            throw TrackingReferenceError.invalidSamplingRate
        }
        self.nominalHz = nominalHz
    }

    // Tune these initial signal-quality thresholds on device data. This changes only
    // eligibility; PCA/periodicity operate on a separate uniformly sampled analysis grid.
    func evaluate(originalTimestamps: [TimeInterval]) -> TrackingWindowEligibility {
        let empty = TrackingWindowEligibility(eligible: false, spanSeconds: 0,
            uniqueOriginalSamples: 0, occupiedSlotCoverage: 0, maximumGapSeconds: 0)
        guard originalTimestamps.count >= 2,
              originalTimestamps.allSatisfy({ $0.isFinite }),
              let first = originalTimestamps.first, let last = originalTimestamps.last else { return empty }
        var maximumGap = 0.0
        for index in 1..<originalTimestamps.count {
            let gap = originalTimestamps[index] - originalTimestamps[index - 1]
            guard gap > 0 else { return empty } // caller handles regression as a frame reset
            maximumGap = max(maximumGap, gap)
        }
        let span = last - first
        // Estimator's caller limits this array to its 2.5 s window; bound defensively.
        guard span > 0, span <= 10 else { return empty }
        let expectedSlots = max(1, Int((span * Double(nominalHz)).rounded()) + 1)
        let occupiedSlots = Set(originalTimestamps.map {
            Int((($0 - first) * Double(nominalHz)).rounded())
        }).count
        let coverage = min(1, Double(occupiedSlots) / Double(expectedSlots))
        let minimumCount = max(12, Int(ceil(Double(nominalHz) * minimumSpanSeconds * minimumCoverage)))
        return TrackingWindowEligibility(
            eligible: span >= minimumSpanSeconds && originalTimestamps.count >= minimumCount
                && coverage >= minimumCoverage && maximumGap <= maximumGapSeconds,
            spanSeconds: span, uniqueOriginalSamples: originalTimestamps.count,
            occupiedSlotCoverage: coverage, maximumGapSeconds: maximumGap)
    }
}

nonisolated struct TrackingRequestTicket: Equatable, Sendable {
    let requestID: UUID
    let itemID: String
    let sessionID: UUID
    let collectorID: String
    let serverKey: String
    let connectionGeneration: UInt64
}

nonisolated struct TrackingDispatchGate: Sendable {
    var connected = false
    var hasOwner = false
    var inFlight: TrackingRequestTicket?
    var retryNotBeforeUptime: TimeInterval?

    func mayPump(nowUptime: TimeInterval) -> Bool {
        guard nowUptime.isFinite, connected, hasOwner, inFlight == nil else { return false }
        return retryNotBeforeUptime.map { nowUptime >= $0 } ?? true
    }

    func maySend(encodedTicket: TrackingRequestTicket, currentConnectionGeneration: UInt64,
                 currentCollectorID: String, currentServerKey: String) -> Bool {
        connected && inFlight == encodedTicket
            && encodedTicket.connectionGeneration == currentConnectionGeneration
            && encodedTicket.collectorID == currentCollectorID
            && encodedTicket.serverKey == currentServerKey
    }
}
