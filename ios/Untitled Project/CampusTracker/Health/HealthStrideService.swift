import Combine
import Foundation
import HealthKit

// MARK: - Pure sample model & aggregation (no HealthKit types, fully testable)

/// A single `walkingStepLength` quantity sample reduced to the fields the aggregator needs.
/// `isIPhoneAutomatic` is resolved by the live query layer from `HKSourceRevision`/`HKDevice`
/// (see `HealthStrideSourceClassifying`) since the pure aggregator never touches HealthKit types.
/// Marked `nonisolated` like the project's other Sendable payload types (e.g. `SensorCapabilities`
/// in SensorModels.swift) because this target defaults new types to `@MainActor` isolation.
nonisolated struct HealthStrideRawSample: Sendable, Equatable {
    let uuid: UUID
    let value: Double
    let startDate: Date
    let endDate: Date
    let wasUserEntered: Bool
    let isIPhoneAutomatic: Bool
}

nonisolated enum HealthStrideRejectionReason: String, Sendable {
    case insufficientSamples
    case insufficientDays
    case stale
    case excessiveDispersion
    case outOfRange
}

nonisolated struct HealthStrideAggregationResult: Sendable {
    let calibration: StrideCalibration?
    let rejectionReason: HealthStrideRejectionReason?
    let finalSampleCount: Int
}

/// Implements the `median_mad_v1` aggregation contract from
/// `docs/HEALTH_STRIDE_SERVER_PLAN.md` section 2. These thresholds are this project's v1
/// experiment defaults, not an Apple accuracy guarantee — changing them means bumping
/// `StrideCalibration.aggregationVersionMedianMadV1` and the server's compatibility check too.
nonisolated enum HealthStrideAggregator {
    static let windowDays = 28
    static let minFinalSampleCount = 20
    static let minObservedDays = 3
    static let maxDispersionM = 0.20
    static let maxLatestSampleAgeDays = 14.0
    static let minValidSampleM = 0.20
    static let maxValidSampleM = 1.50
    static let minStepLengthRangeM = 0.35
    static let maxStepLengthRangeM = 1.10
    static let candidateMaxAgeHours = 24.0

    /// Even-count median is the arithmetic mean of the two middle values.
    static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let count = sorted.count
        if count % 2 == 1 { return sorted[count / 2] }
        return (sorted[count / 2 - 1] + sorted[count / 2]) / 2
    }

    static func medianAbsoluteDeviation(_ values: [Double], median m: Double) -> Double {
        median(values.map { abs($0 - m) })
    }

    static func utcDayKey(_ date: Date) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0)!
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return (components.year ?? 0) * 10_000 + (components.month ?? 0) * 100 + (components.day ?? 0)
    }

    /// `samples` should already be windowed to roughly `[computedAt - windowDays, computedAt]`;
    /// this function re-checks that bound itself so callers can pass a slightly wider HealthKit
    /// query result safely.
    static func aggregate(samples: [HealthStrideRawSample], computedAt: Date) -> HealthStrideAggregationResult {
        let windowStart = computedAt.addingTimeInterval(-Double(windowDays) * 24 * 3600)

        // Diagnostic counts only (no individual sample values/dates logged) to debug rejections
        // without dumping health data to the console.
        let manualCount = samples.filter(\.wasUserEntered).count
        let nonIPhoneCount = samples.filter { !$0.wasUserEntered && !$0.isIPhoneAutomatic }.count
        let outOfWindowOrBoundsCount = samples.filter { sample in
            guard !sample.wasUserEntered, sample.isIPhoneAutomatic else { return false }
            return !(sample.value.isFinite && sample.endDate >= sample.startDate && sample.endDate <= computedAt
                && sample.startDate >= windowStart
                && sample.value >= minValidSampleM && sample.value <= maxValidSampleM)
        }.count

        let basicFiltered = samples.filter { sample in
            guard sample.value.isFinite, sample.endDate >= sample.startDate, sample.endDate <= computedAt else { return false }
            guard !sample.wasUserEntered, sample.isIPhoneAutomatic else { return false }
            guard sample.startDate >= windowStart, sample.endDate <= computedAt else { return false }
            guard sample.value >= minValidSampleM, sample.value <= maxValidSampleM else { return false }
            return true
        }

        var seenUUIDs = Set<UUID>()
        var deduplicated: [HealthStrideRawSample] = []
        for sample in basicFiltered where !seenUUIDs.contains(sample.uuid) {
            seenUUIDs.insert(sample.uuid)
            deduplicated.append(sample)
        }

        print("[HealthStride] aggregate: raw=\(samples.count) manualEntry=\(manualCount) nonIPhoneSource=\(nonIPhoneCount) outOfWindowOrBounds=\(outOfWindowOrBoundsCount) afterBasicFilter=\(basicFiltered.count) afterDedup=\(deduplicated.count)")

        guard !deduplicated.isEmpty else {
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .insufficientSamples, finalSampleCount: 0)
        }

        let initialValues = deduplicated.map(\.value)
        let m0 = median(initialValues)
        let mad0 = medianAbsoluteDeviation(initialValues, median: m0)
        let outlierThreshold = max(3 * 1.4826 * mad0, 0.10)
        let final = deduplicated.filter { abs($0.value - m0) <= outlierThreshold }

        print("[HealthStride] aggregate: afterOutlierRejection=\(final.count) (threshold=\(outlierThreshold))")

        guard final.count >= minFinalSampleCount else {
            print("[HealthStride] aggregate: REJECTED insufficientSamples finalCount=\(final.count) required=\(minFinalSampleCount)")
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .insufficientSamples, finalSampleCount: final.count)
        }

        let observedDays = Set(final.map { utcDayKey($0.endDate) }).count
        guard observedDays >= minObservedDays else {
            print("[HealthStride] aggregate: REJECTED insufficientDays observedDays=\(observedDays) required=\(minObservedDays)")
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .insufficientDays, finalSampleCount: final.count)
        }

        let finalValues = final.map(\.value)
        let stepLengthM = median(finalValues)
        let dispersionM = 1.4826 * medianAbsoluteDeviation(finalValues, median: stepLengthM)
        guard dispersionM <= maxDispersionM else {
            print("[HealthStride] aggregate: REJECTED excessiveDispersion dispersionM=\(dispersionM) max=\(maxDispersionM)")
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .excessiveDispersion, finalSampleCount: final.count)
        }

        guard let latestSampleAt = final.map(\.endDate).max() else {
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .insufficientSamples, finalSampleCount: final.count)
        }
        let latestSampleAgeDays = computedAt.timeIntervalSince(latestSampleAt) / (24 * 3600)
        guard latestSampleAgeDays <= maxLatestSampleAgeDays else {
            print("[HealthStride] aggregate: REJECTED stale latestSampleAgeDays=\(latestSampleAgeDays) max=\(maxLatestSampleAgeDays)")
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .stale, finalSampleCount: final.count)
        }

        guard stepLengthM >= minStepLengthRangeM, stepLengthM <= maxStepLengthRangeM else {
            print("[HealthStride] aggregate: REJECTED outOfRange stepLengthM=\(stepLengthM) range=\(minStepLengthRangeM)...\(maxStepLengthRangeM)")
            return HealthStrideAggregationResult(calibration: nil, rejectionReason: .outOfRange, finalSampleCount: final.count)
        }

        print("[HealthStride] aggregate: ACCEPTED stepLengthM=\(stepLengthM) sampleCount=\(final.count) observedDays=\(observedDays) dispersionM=\(dispersionM)")

        let calibration = StrideCalibration(
            schemaVersion: StrideCalibration.schemaVersionV1,
            source: StrideCalibration.sourceAppleHealthWalkingStepLength,
            aggregationVersion: StrideCalibration.aggregationVersionMedianMadV1,
            sourcePolicy: StrideCalibration.sourcePolicyIPhoneAutomaticV1,
            stepLengthM: stepLengthM,
            sampleCount: final.count,
            observedDays: observedDays,
            dispersionM: dispersionM,
            windowStart: windowStart,
            windowEnd: computedAt,
            latestSampleAt: latestSampleAt,
            computedAt: computedAt
        )
        return HealthStrideAggregationResult(calibration: calibration, rejectionReason: nil, finalSampleCount: final.count)
    }

    /// Re-checked at session start against the session's actual `startedAt` (not `computedAt`,
    /// and not "now") per the server contract: a candidate computed long before the session
    /// actually starts, or built from samples that are themselves stale by then, must not be
    /// copied into the session.
    static func isCandidateFreshEnough(_ calibration: StrideCalibration, sessionStartedAt: Date) -> Bool {
        let candidateAgeHours = sessionStartedAt.timeIntervalSince(calibration.computedAt) / 3600
        guard candidateAgeHours >= 0, candidateAgeHours <= candidateMaxAgeHours else { return false }
        let latestSampleAgeDays = sessionStartedAt.timeIntervalSince(calibration.latestSampleAt) / (24 * 3600)
        guard latestSampleAgeDays >= 0, latestSampleAgeDays <= maxLatestSampleAgeDays else { return false }
        return true
    }
}

// MARK: - Source policy (requires live HealthKit source/device info, so it's separate from the pure aggregator)

nonisolated protocol HealthStrideSourceClassifying: Sendable {
    func isIPhoneAutomatic(sourceRevision: HKSourceRevision, device: HKDevice?) -> Bool
}

/// `walkingStepLength` is written directly by the Health daemon from the iPhone's own sensors,
/// never by a third-party app. Confirmed on a real device (iPhone 14 Pro, 2026-10-07): HealthKit
/// attributes those writes to a source bundle identifier of the form
/// `com.apple.health.<UUID>` — a per-source-device suffix appended to `com.apple.health`, not the
/// bare string — with `productType` `iPhone14,2` and `device.model` `"iPhone"`. A synced Apple
/// Watch sample, a manually-entered value, or (hypothetically) a third-party app would fail at
/// least one of these checks, so all three signals must agree rather than trusting a single
/// display name or a guessed bundle identifier.
nonisolated struct DefaultHealthStrideSourceClassifier: HealthStrideSourceClassifying {
    func isIPhoneAutomatic(sourceRevision: HKSourceRevision, device: HKDevice?) -> Bool {
        let bundleIdentifier = sourceRevision.source.bundleIdentifier
        guard bundleIdentifier == "com.apple.health" || bundleIdentifier.hasPrefix("com.apple.health.") else { return false }
        guard let productType = sourceRevision.productType, productType.hasPrefix("iPhone") else { return false }
        if let model = device?.model, !model.isEmpty, !model.localizedCaseInsensitiveContains("iPhone") {
            return false
        }
        return true
    }
}

// MARK: - Live HealthKit query (injectable for testing)

nonisolated protocol HealthKitStrideQuerying: Sendable {
    func isHealthDataAvailable() -> Bool
    func requestReadAuthorization() async throws
    func walkingStepLengthSamples(from start: Date, to end: Date) async throws -> [HealthStrideRawSample]
}

nonisolated final class HealthKitStrideStore: HealthKitStrideQuerying, @unchecked Sendable {
    private let healthStore = HKHealthStore()
    private let sourceClassifier: HealthStrideSourceClassifying

    init(sourceClassifier: HealthStrideSourceClassifying = DefaultHealthStrideSourceClassifier()) {
        self.sourceClassifier = sourceClassifier
    }

    func isHealthDataAvailable() -> Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestReadAuthorization() async throws {
        guard let type = HKObjectType.quantityType(forIdentifier: .walkingStepLength) else { return }
        try await healthStore.requestAuthorization(toShare: [], read: [type])
    }

    /// Uses the completion-handler `HKSampleQuery` (available since iOS 8) rather than
    /// `HKSampleQueryDescriptor`, since this target's deployment floor predates the descriptor's
    /// introduction.
    func walkingStepLengthSamples(from start: Date, to end: Date) async throws -> [HealthStrideRawSample] {
        guard let type = HKObjectType.quantityType(forIdentifier: .walkingStepLength) else { return [] }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate, .strictEndDate])
        let sourceClassifier = self.sourceClassifier
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let unit = HKUnit.meter()
                let quantitySamples = (samples as? [HKQuantitySample]) ?? []
                print("[HealthStride] HKSampleQuery returned \(quantitySamples.count) raw walkingStepLength samples")
                // Diagnostic only: source metadata (bundle id / product type / device model),
                // never the health value itself, to debug why a sample is or isn't classified as
                // iPhone-automatic without dumping personal health data to the console.
                var loggedSourceVariants = Set<String>()
                let mapped = quantitySamples.map { sample -> HealthStrideRawSample in
                    let isIPhoneAutomatic = sourceClassifier.isIPhoneAutomatic(sourceRevision: sample.sourceRevision, device: sample.device)
                    let variantKey = "\(sample.sourceRevision.source.bundleIdentifier)|\(sample.sourceRevision.productType ?? "nil")|\(sample.device?.model ?? "nil")|\(isIPhoneAutomatic)"
                    if !loggedSourceVariants.contains(variantKey) {
                        loggedSourceVariants.insert(variantKey)
                        print("[HealthStride] source variant: bundleId=\(sample.sourceRevision.source.bundleIdentifier) productType=\(sample.sourceRevision.productType ?? "nil") deviceModel=\(sample.device?.model ?? "nil") -> isIPhoneAutomatic=\(isIPhoneAutomatic)")
                    }
                    return HealthStrideRawSample(
                        uuid: sample.uuid,
                        value: sample.quantity.doubleValue(for: unit),
                        startDate: sample.startDate,
                        endDate: sample.endDate,
                        wasUserEntered: (sample.metadata?[HKMetadataKeyWasUserEntered] as? Bool) ?? false,
                        isIPhoneAutomatic: isIPhoneAutomatic
                    )
                }
                continuation.resume(returning: mapped)
            }
            self.healthStore.execute(query)
        }
    }
}

// MARK: - App-facing service

@MainActor
final class HealthStrideService: ObservableObject {
    enum Status: Equatable {
        case disabled
        case loading
        case ready(StrideCalibration)
        case unavailable(String)
    }

    @Published private(set) var status: Status = .disabled
    @Published private(set) var isEnabled: Bool

    private let query: HealthKitStrideQuerying
    private let defaults: UserDefaults
    private let enabledKey = "CampusTracker.healthStrideEnabled"
    /// Bumped whenever enablement is toggled off or results must be invalidated, so a
    /// late-arriving query result from a cancelled/superseded refresh never resurrects a stale
    /// candidate (covers option-disable-mid-query and rapid repeated foreground triggers).
    private var generation = 0
    private var isRefreshing = false
    /// Process-memory only — a fresh process always re-queries, per the no-cross-launch-cache
    /// requirement.
    private var readyCandidate: StrideCalibration?

    init(query: HealthKitStrideQuerying = HealthKitStrideStore(), defaults: UserDefaults = .standard) {
        self.query = query
        self.defaults = defaults
        self.isEnabled = defaults.bool(forKey: enabledKey)
    }

    /// Returns the background `Task` it launches (nil when disabling, or when already in the
    /// requested state) only so tests can `await task?.value` instead of racing the UI's
    /// fire-and-forget call. Production call sites discard it.
    @discardableResult
    func setEnabled(_ enabled: Bool) -> Task<Void, Never>? {
        guard enabled != isEnabled else { return nil }
        isEnabled = enabled
        defaults.set(enabled, forKey: enabledKey)
        generation += 1
        readyCandidate = nil
        guard enabled else {
            status = .disabled
            return nil
        }
        status = .loading
        return Task { await requestAuthorizationThenRefresh() }
    }

    @discardableResult
    func refresh() -> Task<Void, Never>? {
        guard isEnabled, !isRefreshing else { return nil }
        return Task { await performRefresh() }
    }

    func refreshOnForegroundEntry() {
        guard isEnabled else { return }
        refresh()
    }

    /// Called synchronously from `CollectionCoordinator.startSession`. Never awaits an in-flight
    /// query — a session that starts before a query finishes simply gets no calibration.
    func readyCandidateForNewSession(sessionStartedAt: Date) -> StrideCalibration? {
        guard isEnabled, let candidate = readyCandidate else { return nil }
        guard HealthStrideAggregator.isCandidateFreshEnough(candidate, sessionStartedAt: sessionStartedAt) else { return nil }
        return candidate
    }

    /// Internal (not `private`) rather than adding a separate test seam: this lets tests await
    /// the enable→authorize→refresh sequence deterministically via `@testable import`, instead
    /// of racing the fire-and-forget `Task` that `setEnabled` launches for the real UI.
    func requestAuthorizationThenRefresh() async {
        let myGeneration = generation
        guard query.isHealthDataAvailable() else {
            apply(generation: myGeneration) {
                self.status = .unavailable("이 기기에서는 건강 데이터를 사용할 수 없습니다. 기본 보폭을 사용합니다.")
            }
            return
        }
        do {
            try await query.requestReadAuthorization()
        } catch {
            apply(generation: myGeneration) {
                self.status = .unavailable("건강 데이터 접근 요청에 실패했습니다. 기본 보폭을 사용합니다.")
            }
            return
        }
        guard myGeneration == generation else { return }
        await performRefresh(generation: myGeneration)
    }

    /// Internal for the same reason as `requestAuthorizationThenRefresh`: awaitable from tests.
    func performRefresh(generation requestedGeneration: Int? = nil) async {
        guard !isRefreshing else { return }
        let myGeneration = requestedGeneration ?? generation
        isRefreshing = true
        defer { isRefreshing = false }

        apply(generation: myGeneration) { self.status = .loading }
        guard query.isHealthDataAvailable() else {
            apply(generation: myGeneration) {
                self.readyCandidate = nil
                self.status = .unavailable("이 기기에서는 건강 데이터를 사용할 수 없습니다. 기본 보폭을 사용합니다.")
            }
            return
        }
        let computedAt = Date()
        let windowStart = computedAt.addingTimeInterval(-Double(HealthStrideAggregator.windowDays) * 24 * 3600)
        print("[HealthStride] performRefresh querying window \(windowStart) ... \(computedAt)")
        do {
            let samples = try await query.walkingStepLengthSamples(from: windowStart, to: computedAt)
            let result = HealthStrideAggregator.aggregate(samples: samples, computedAt: computedAt)
            apply(generation: myGeneration) {
                if let calibration = result.calibration {
                    self.readyCandidate = calibration
                    self.status = .ready(calibration)
                } else {
                    self.readyCandidate = nil
                    self.status = .unavailable("읽을 수 있는 보폭 데이터가 없습니다. 기본 보폭을 사용합니다.")
                }
            }
        } catch {
            apply(generation: myGeneration) {
                self.readyCandidate = nil
                self.status = .unavailable("건강 데이터를 불러오지 못했습니다. 기본 보폭을 사용합니다.")
            }
        }
    }

    private func apply(generation myGeneration: Int, _ body: () -> Void) {
        guard myGeneration == generation else { return }
        body()
    }
}
