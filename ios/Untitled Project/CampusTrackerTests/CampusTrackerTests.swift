import Foundation
import Testing
@testable import CampusTracker

// MARK: - Fixtures

private let referenceComputedAt = Date(timeIntervalSince1970: 1_800_000_000) // fixed, arbitrary UTC instant

private func rawSample(
    daysAgo: Double,
    value: Double,
    computedAt: Date = referenceComputedAt,
    uuid: UUID = UUID(),
    wasUserEntered: Bool = false,
    isIPhoneAutomatic: Bool = true
) -> HealthStrideRawSample {
    let end = computedAt.addingTimeInterval(-daysAgo * 24 * 3600)
    let start = end.addingTimeInterval(-30)
    return HealthStrideRawSample(
        uuid: uuid,
        value: value,
        startDate: start,
        endDate: end,
        wasUserEntered: wasUserEntered,
        isIPhoneAutomatic: isIPhoneAutomatic
    )
}

/// `count` samples of `value`, spread across `days` distinct UTC days (as evenly as possible),
/// all well within the 28-day window and 14-day staleness limit.
private func uniformSamples(count: Int, value: Double, days: Int, computedAt: Date = referenceComputedAt) -> [HealthStrideRawSample] {
    (0..<count).map { index in
        let dayOffset = Double(index % days) + 1
        return rawSample(daysAgo: dayOffset, value: value, computedAt: computedAt)
    }
}

// MARK: - Aggregator: median / MAD primitives

struct HealthStrideAggregatorPrimitivesTests {
    @Test func medianOfOddCount() {
        #expect(HealthStrideAggregator.median([0.7, 0.6, 0.9]) == 0.7)
    }

    @Test func medianOfEvenCountAveragesMiddleTwo() {
        #expect(HealthStrideAggregator.median([0.6, 0.8]) == 0.7)
        #expect(HealthStrideAggregator.median([0.9, 0.6, 0.8, 0.7]) == 0.75)
    }

    @Test func medianAbsoluteDeviationIsZeroForIdenticalValues() {
        let values = [0.7, 0.7, 0.7, 0.7]
        #expect(HealthStrideAggregator.medianAbsoluteDeviation(values, median: 0.7) == 0.0)
    }

    @Test func utcDayKeyDistinguishesSamplesAcrossUTCMidnight() {
        let beforeMidnight = Date(timeIntervalSince1970: 1_800_000_000 - 60) // just before a UTC day boundary is irrelevant; use explicit components
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let base = calendar.date(from: DateComponents(year: 2026, month: 1, day: 2, hour: 0, minute: 0, second: 0))!
        let justBefore = base.addingTimeInterval(-1) // 2026-01-01T23:59:59Z
        let justAfter = base // 2026-01-02T00:00:00Z
        #expect(HealthStrideAggregator.utcDayKey(justBefore) != HealthStrideAggregator.utcDayKey(justAfter))
        #expect(HealthStrideAggregator.utcDayKey(justBefore) == 20260101)
        #expect(HealthStrideAggregator.utcDayKey(justAfter) == 20260102)
        _ = beforeMidnight
    }
}

// MARK: - Aggregator: filtering rules

struct HealthStrideAggregatorFilteringTests {
    @Test func rejectsManuallyEnteredSamplesEvenWhenOtherwiseValid() {
        var samples = uniformSamples(count: 20, value: 0.70, days: 3)
        samples[0] = rawSample(daysAgo: 1, value: 0.70, wasUserEntered: true)
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        // One manual entry dropped from 20 -> 19, which is itself below the minimum.
        #expect(result.calibration == nil)
        #expect(result.rejectionReason == .insufficientSamples)
    }

    @Test func rejectsNonIPhoneAutomaticSource() {
        var samples = uniformSamples(count: 20, value: 0.70, days: 3)
        samples[0] = rawSample(daysAgo: 1, value: 0.70, isIPhoneAutomatic: false)
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        #expect(result.calibration == nil)
        #expect(result.rejectionReason == .insufficientSamples)
    }

    @Test func dedupesSamplesSharingTheSameUUID() {
        let sharedUUID = UUID()
        var samples = uniformSamples(count: 20, value: 0.70, days: 3)
        // Append a duplicate of an existing UUID with a different value; it must not count twice
        // and must not perturb the median since it's discarded entirely.
        samples[0] = rawSample(daysAgo: 1, value: 0.70, uuid: sharedUUID)
        samples.append(rawSample(daysAgo: 1, value: 0.95, uuid: sharedUUID))
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        #expect(result.finalSampleCount == 20)
        #expect(result.calibration?.stepLengthM == 0.70)
    }

    @Test func rejectsStatisticalOutlierButKeepsTheRest() {
        var samples = uniformSamples(count: 24, value: 0.70, days: 3)
        samples[0] = rawSample(daysAgo: 1, value: 1.49) // within raw 0.20-1.50 bound, but a huge outlier vs MAD0
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        #expect(result.finalSampleCount == 23)
        #expect(result.calibration?.stepLengthM == 0.70)
    }

    @Test func rawValueOutsideHardBoundsIsExcludedBeforeOutlierStep() {
        var samples = uniformSamples(count: 20, value: 0.70, days: 3)
        samples[0] = rawSample(daysAgo: 1, value: 1.51) // over the 1.50m hard ceiling
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        #expect(result.calibration == nil)
        #expect(result.rejectionReason == .insufficientSamples)
    }
}

// MARK: - Aggregator: thresholds (19/20, 2/3 days, staleness, dispersion, range)

struct HealthStrideAggregatorThresholdTests {
    @Test func sampleCountBoundary19vs20() {
        let nineteen = uniformSamples(count: 19, value: 0.70, days: 3)
        let twenty = uniformSamples(count: 20, value: 0.70, days: 3)
        #expect(HealthStrideAggregator.aggregate(samples: nineteen, computedAt: referenceComputedAt).calibration == nil)
        #expect(HealthStrideAggregator.aggregate(samples: twenty, computedAt: referenceComputedAt).calibration != nil)
    }

    @Test func observedDaysBoundary2vs3() {
        let twoDays = uniformSamples(count: 20, value: 0.70, days: 2)
        let threeDays = uniformSamples(count: 20, value: 0.70, days: 3)
        let twoDaysResult = HealthStrideAggregator.aggregate(samples: twoDays, computedAt: referenceComputedAt)
        #expect(twoDaysResult.calibration == nil)
        #expect(twoDaysResult.rejectionReason == .insufficientDays)
        #expect(HealthStrideAggregator.aggregate(samples: threeDays, computedAt: referenceComputedAt).calibration != nil)
    }

    @Test func latestSampleStalenessBoundaryAt14Days() {
        var atBoundary = uniformSamples(count: 20, value: 0.70, days: 3)
        atBoundary[0] = rawSample(daysAgo: 14.0, value: 0.70) // exactly 14 days old: still allowed
        let atResult = HealthStrideAggregator.aggregate(samples: atBoundary, computedAt: referenceComputedAt)
        #expect(atResult.calibration != nil)

        // Spread over 3 distinct days (so staleness, not day-count, is the only thing that can
        // fail), but with the *freshest* sample still more than 14 days old.
        let overBoundary = (0..<21).map { index in
            rawSample(daysAgo: 15.0 + Double(index % 3), value: 0.70)
        }
        let overResult = HealthStrideAggregator.aggregate(samples: overBoundary, computedAt: referenceComputedAt)
        #expect(overResult.calibration == nil)
        #expect(overResult.rejectionReason == .stale)
    }

    @Test func dispersionBoundaryAt0_20Meters() {
        // Split samples symmetrically around 0.70 by distance d; MAD(final) == d, so
        // dispersionM == 1.4826 * d exactly.
        func symmetricSamples(halfSpread d: Double) -> [HealthStrideRawSample] {
            (0..<24).map { index in
                let value = index % 2 == 0 ? 0.70 - d : 0.70 + d
                let dayOffset = Double(index % 3) + 1
                return rawSample(daysAgo: dayOffset, value: value)
            }
        }
        // Avoid asserting exactly at the 0.20 boundary: floating-point rounding in
        // `1.4826 * d` can land a hair above or below the literal 0.20 cutoff regardless of
        // which side the test intends, so assert comfortably inside and outside it instead.
        let underD = 0.19 / 1.4826
        let underResult = HealthStrideAggregator.aggregate(samples: symmetricSamples(halfSpread: underD), computedAt: referenceComputedAt)
        #expect(underResult.calibration != nil)
        #expect(underResult.calibration.map { $0.dispersionM <= 0.20 } == true)

        let overD = 0.21 / 1.4826
        let overBoundary = HealthStrideAggregator.aggregate(samples: symmetricSamples(halfSpread: overD), computedAt: referenceComputedAt)
        #expect(overBoundary.calibration == nil)
        #expect(overBoundary.rejectionReason == .excessiveDispersion)
    }

    @Test func uniformuniformSamplesWithZeroDispersionAreAccepted() {
        let samples = uniformSamples(count: 20, value: 0.70, days: 3)
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        #expect(result.calibration?.dispersionM == 0.0)
    }

    @Test func stepLengthRangeBoundaries() {
        let atLow = HealthStrideAggregator.aggregate(samples: uniformSamples(count: 20, value: 0.35, days: 3), computedAt: referenceComputedAt)
        #expect(atLow.calibration != nil)
        let belowLow = HealthStrideAggregator.aggregate(samples: uniformSamples(count: 20, value: 0.349, days: 3), computedAt: referenceComputedAt)
        #expect(belowLow.calibration == nil)
        #expect(belowLow.rejectionReason == .outOfRange)

        let atHigh = HealthStrideAggregator.aggregate(samples: uniformSamples(count: 20, value: 1.10, days: 3), computedAt: referenceComputedAt)
        #expect(atHigh.calibration != nil)
        let aboveHigh = HealthStrideAggregator.aggregate(samples: uniformSamples(count: 20, value: 1.101, days: 3), computedAt: referenceComputedAt)
        #expect(aboveHigh.calibration == nil)
        #expect(aboveHigh.rejectionReason == .outOfRange)
    }

    @Test func acceptedCalibrationCarriesExpectedContractFields() throws {
        let samples = uniformSamples(count: 20, value: 0.70, days: 3)
        let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: referenceComputedAt)
        let calibration = try #require(result.calibration)
        #expect(calibration.schemaVersion == StrideCalibration.schemaVersionV1)
        #expect(calibration.source == StrideCalibration.sourceAppleHealthWalkingStepLength)
        #expect(calibration.aggregationVersion == StrideCalibration.aggregationVersionMedianMadV1)
        #expect(calibration.sourcePolicy == StrideCalibration.sourcePolicyIPhoneAutomaticV1)
        #expect(calibration.windowEnd == referenceComputedAt)
        #expect(calibration.windowStart == referenceComputedAt.addingTimeInterval(-28 * 24 * 3600))
        #expect(calibration.computedAt == referenceComputedAt)
        #expect(calibration.sampleCount == 20)
        #expect(calibration.observedDays == 3)
    }
}

// MARK: - Candidate freshness at session start (24h computedAt / 14d latestSampleAt re-check)

struct HealthStrideCandidateFreshnessTests {
    private func calibration(computedAt: Date, latestSampleAt: Date) -> StrideCalibration {
        StrideCalibration(
            schemaVersion: StrideCalibration.schemaVersionV1,
            source: StrideCalibration.sourceAppleHealthWalkingStepLength,
            aggregationVersion: StrideCalibration.aggregationVersionMedianMadV1,
            sourcePolicy: StrideCalibration.sourcePolicyIPhoneAutomaticV1,
            stepLengthM: 0.70,
            sampleCount: 20,
            observedDays: 3,
            dispersionM: 0.0,
            windowStart: computedAt.addingTimeInterval(-28 * 24 * 3600),
            windowEnd: computedAt,
            latestSampleAt: latestSampleAt,
            computedAt: computedAt
        )
    }

    @Test func candidateAgeBoundaryAt24Hours() {
        let computedAt = referenceComputedAt
        let latest = computedAt.addingTimeInterval(-3600)
        let atBoundary = calibration(computedAt: computedAt, latestSampleAt: latest)
        #expect(HealthStrideAggregator.isCandidateFreshEnough(atBoundary, sessionStartedAt: computedAt.addingTimeInterval(24 * 3600)))
        #expect(!HealthStrideAggregator.isCandidateFreshEnough(atBoundary, sessionStartedAt: computedAt.addingTimeInterval(24 * 3600 + 1)))
    }

    @Test func latestSampleAgeBoundaryAt14Days() {
        let computedAt = referenceComputedAt
        let sessionStartedAt = computedAt.addingTimeInterval(3600)
        let atBoundary = calibration(computedAt: computedAt, latestSampleAt: sessionStartedAt.addingTimeInterval(-14 * 24 * 3600))
        #expect(HealthStrideAggregator.isCandidateFreshEnough(atBoundary, sessionStartedAt: sessionStartedAt))
        let overBoundary = calibration(computedAt: computedAt, latestSampleAt: sessionStartedAt.addingTimeInterval(-14 * 24 * 3600 - 1))
        #expect(!HealthStrideAggregator.isCandidateFreshEnough(overBoundary, sessionStartedAt: sessionStartedAt))
    }

    @Test func futureComputedAtRelativeToSessionIsNeverFresh() {
        let computedAt = referenceComputedAt
        let candidate = calibration(computedAt: computedAt, latestSampleAt: computedAt.addingTimeInterval(-60))
        #expect(!HealthStrideAggregator.isCandidateFreshEnough(candidate, sessionStartedAt: computedAt.addingTimeInterval(-1)))
    }
}

// MARK: - JSON compatibility: old sessions/ACKs must still decode

struct StrideCalibrationCompatibilityTests {
    @Test func collectionSessionDecodesWhenStrideCalibrationKeyIsAbsent() throws {
        let json = """
        {
            "id": "\(UUID().uuidString)",
            "collectorId": "C01",
            "deviceId": "\(UUID().uuidString)",
            "startedAt": "2026-10-01T00:00:00Z",
            "status": "recording",
            "deviceModel": "iPhone",
            "systemVersion": "18.0",
            "sensorCapabilities": {
                "locationAvailable": true,
                "deviceMotionAvailable": true,
                "altimeterAvailable": true,
                "stepCountingAvailable": true,
                "distanceAvailable": true,
                "floorCountingAvailable": true,
                "paceAvailable": true,
                "cadenceAvailable": true
            },
            "sampleCounts": {"location": 0, "motion": 0, "altimeter": 0, "pedometer": 0, "marker": 0}
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let session = try decoder.decode(CollectionSession.self, from: Data(json.utf8))
        #expect(session.strideCalibration == nil)
        #expect(session.collectorId == "C01")
    }

    @Test func collectionSessionRoundTripsWithStrideCalibrationPresent() throws {
        let computedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let calibration = StrideCalibration(
            schemaVersion: StrideCalibration.schemaVersionV1,
            source: StrideCalibration.sourceAppleHealthWalkingStepLength,
            aggregationVersion: StrideCalibration.aggregationVersionMedianMadV1,
            sourcePolicy: StrideCalibration.sourcePolicyIPhoneAutomaticV1,
            stepLengthM: 0.74,
            sampleCount: 84,
            observedDays: 12,
            dispersionM: 0.06,
            windowStart: computedAt.addingTimeInterval(-28 * 24 * 3600),
            windowEnd: computedAt,
            latestSampleAt: computedAt.addingTimeInterval(-7200),
            computedAt: computedAt
        )
        let session = CollectionSession(
            id: UUID(),
            collectorId: "C01",
            deviceId: UUID(),
            startedAt: computedAt,
            status: .recording,
            deviceModel: "iPhone",
            systemVersion: "18.0",
            sensorCapabilities: SensorCapabilities(
                locationAvailable: true, deviceMotionAvailable: true, altimeterAvailable: true,
                stepCountingAvailable: true, distanceAvailable: true, floorCountingAvailable: true,
                paceAvailable: true, cadenceAvailable: true
            ),
            sampleCounts: SampleCounts(),
            strideCalibration: calibration
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(CollectionSession.self, from: encoder.encode(session))
        #expect(decoded.strideCalibration == calibration)
    }

    @Test func strideCalibrationAckDecodesUnknownFutureStatusAndReason() throws {
        let json = """
        { "status": "SOMETHING_FUTURE_SERVERS_ADDED", "reason": "A_NEW_REASON_CODE" }
        """
        let decoded = try JSONDecoder().decode(StrideCalibrationAck.self, from: Data(json.utf8))
        #expect(decoded.status == "SOMETHING_FUTURE_SERVERS_ADDED")
        #expect(decoded.reason == "A_NEW_REASON_CODE")
    }

    @Test func strideCalibrationAckReasonIsOptional() throws {
        let json = """
        { "status": "ACCEPTED", "reason": null }
        """
        let decoded = try JSONDecoder().decode(StrideCalibrationAck.self, from: Data(json.utf8))
        #expect(decoded.status == "ACCEPTED")
        #expect(decoded.reason == nil)
    }
}

// MARK: - HealthStrideService: enablement, refresh, and race safety

private final class MockHealthKitStrideQuerying: HealthKitStrideQuerying, @unchecked Sendable {
    private let available: Bool
    private let authorizationError: Error?
    private let samplesResult: Result<[HealthStrideRawSample], Error>
    private let gated: Bool
    private var pendingContinuation: CheckedContinuation<[HealthStrideRawSample], Error>?
    private let lock = NSLock()

    init(
        available: Bool = true,
        authorizationError: Error? = nil,
        samplesResult: Result<[HealthStrideRawSample], Error> = .success([]),
        gated: Bool = false
    ) {
        self.available = available
        self.authorizationError = authorizationError
        self.samplesResult = samplesResult
        self.gated = gated
    }

    func isHealthDataAvailable() -> Bool { available }

    func requestReadAuthorization() async throws {
        if let authorizationError { throw authorizationError }
    }

    func walkingStepLengthSamples(from start: Date, to end: Date) async throws -> [HealthStrideRawSample] {
        guard gated else { return try samplesResult.get() }
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            pendingContinuation = continuation
            lock.unlock()
        }
    }

    func release(with result: Result<[HealthStrideRawSample], Error>) {
        lock.lock()
        let continuation = pendingContinuation
        pendingContinuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    /// True once `walkingStepLengthSamples` has actually been called and is parked on the gate.
    /// Tests poll this instead of racing blindly, since an unstructured `Task` created inside a
    /// synchronous `@MainActor` call doesn't start running until the caller yields.
    var isParked: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pendingContinuation != nil
    }
}

private struct StubError: Error {}

@MainActor
struct HealthStrideServiceTests {
    @Test func readyCandidateIsNilWhenServiceNeverEnabled() {
        let service = HealthStrideService(query: MockHealthKitStrideQuerying(), defaults: makeIsolatedDefaults())
        #expect(service.readyCandidateForNewSession(sessionStartedAt: referenceComputedAt) == nil)
    }

    @Test func enablingWithSufficientDataProducesReadyCandidate() async {
        // `HealthStrideService.performRefresh` stamps `computedAt` with the real `Date()`
        // internally, so fixtures here must be relative to now — not the fixed
        // `referenceComputedAt` used by the pure-aggregator tests above — or every sample looks
        // like it's from the future and gets filtered out.
        let samples = uniformSamples(count: 20, value: 0.70, days: 3, computedAt: Date())
        let mock = MockHealthKitStrideQuerying(samplesResult: .success(samples))
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        await service.setEnabled(true)?.value
        guard case let .ready(calibration) = service.status else {
            Issue.record("expected .ready, got \(service.status)")
            return
        }
        #expect(calibration.stepLengthM == 0.70)
        #expect(service.readyCandidateForNewSession(sessionStartedAt: Date()) != nil)
    }

    @Test func deviceUnavailableYieldsUnavailableStatusAndNoCandidate() async {
        let mock = MockHealthKitStrideQuerying(available: false)
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        await service.setEnabled(true)?.value
        guard case .unavailable = service.status else {
            Issue.record("expected .unavailable, got \(service.status)")
            return
        }
        #expect(service.readyCandidateForNewSession(sessionStartedAt: Date()) == nil)
    }

    @Test func authorizationFailureYieldsUnavailableStatus() async {
        let mock = MockHealthKitStrideQuerying(authorizationError: StubError())
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        await service.setEnabled(true)?.value
        guard case .unavailable = service.status else {
            Issue.record("expected .unavailable, got \(service.status)")
            return
        }
        #expect(service.readyCandidateForNewSession(sessionStartedAt: Date()) == nil)
    }

    @Test func emptyHealthResultsYieldUnavailableStatusWithoutBlockingSessionStart() async {
        let mock = MockHealthKitStrideQuerying(samplesResult: .success([]))
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        await service.setEnabled(true)?.value
        guard case .unavailable = service.status else {
            Issue.record("expected .unavailable, got \(service.status)")
            return
        }
        // The contract under test: regardless of Health state, this call never throws or blocks.
        #expect(service.readyCandidateForNewSession(sessionStartedAt: Date()) == nil)
    }

    @Test func queryErrorYieldsUnavailableStatus() async {
        let mock = MockHealthKitStrideQuerying(samplesResult: .failure(StubError()))
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        await service.setEnabled(true)?.value
        guard case .unavailable = service.status else {
            Issue.record("expected .unavailable, got \(service.status)")
            return
        }
    }

    @Test func disablingMidQueryDiscardsALateArrivingResult() async {
        let samples = uniformSamples(count: 20, value: 0.70, days: 3, computedAt: referenceComputedAt)
        let mock = MockHealthKitStrideQuerying(samplesResult: .success(samples), gated: true)
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())

        let enableTask = service.setEnabled(true)
        // Wait until the background task has actually reached (and parked on) the gated query,
        // so `requestAuthorizationThenRefresh` has already captured the *pre-disable* generation
        // — otherwise the unstructured Task wouldn't start running until this test yields, and
        // disabling first would race the generation capture instead of the query itself.
        while !mock.isParked { await Task.yield() }
        // Disable now, before the result arrives.
        service.setEnabled(false)
        #expect(service.status == .disabled)

        // Let the stale query finally resolve.
        mock.release(with: .success(samples))
        await enableTask?.value

        #expect(service.status == .disabled)
        #expect(service.readyCandidateForNewSession(sessionStartedAt: Date()) == nil)
    }

    @Test func refreshCoalescesWhileAnotherRefreshIsInFlight() async {
        let mock = MockHealthKitStrideQuerying(samplesResult: .success([]), gated: true)
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        let enableTask = service.setEnabled(true)
        // `isRefreshing` is set before the gated query call, so by the time we're parked here
        // the in-flight flag is already true.
        while !mock.isParked { await Task.yield() }

        // A second refresh request while the first is still in flight must be a no-op (coalesced),
        // not a second overlapping query.
        let secondTask = service.refresh()
        #expect(secondTask == nil)

        mock.release(with: .success([]))
        await enableTask?.value
    }

    @Test func sequentialRefreshesAdoptTheLastValidState() async {
        let firstSamples = uniformSamples(count: 20, value: 0.70, days: 3, computedAt: Date())
        let mock = MockHealthKitStrideQuerying(samplesResult: .success(firstSamples))
        let service = HealthStrideService(query: mock, defaults: makeIsolatedDefaults())
        await service.setEnabled(true)?.value
        guard case let .ready(first) = service.status else {
            Issue.record("expected first refresh to be ready")
            return
        }
        #expect(first.stepLengthM == 0.70)

        // Second foreground entry with no usable data this time.
        let emptyMock = MockHealthKitStrideQuerying(samplesResult: .success([]))
        let service2 = HealthStrideService(query: emptyMock, defaults: makeIsolatedDefaults())
        await service2.setEnabled(true)?.value
        guard case .unavailable = service2.status else {
            Issue.record("expected second refresh to be unavailable")
            return
        }
    }
}

private func makeIsolatedDefaults() -> UserDefaults {
    UserDefaults(suiteName: "CampusTrackerTests.\(UUID().uuidString)")!
}
