import Foundation
import Testing
@testable import CampusTracker

private struct TrackingDateFixture: Codable {
    let date: Date
}

struct SensorClockMapperTests {
    @Test func callbackDelayDoesNotChangeMapping() throws {
        let epoch = Date(timeIntervalSince1970: 1_700_000_000)
        let anchor = try TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: 100)
        #expect(try anchor.map(nativeTimestamp: 101) == epoch.addingTimeInterval(1))
        #expect(try anchor.deliveryResidual(nativeTimestamp: 101,
            callbackEpoch: epoch.addingTimeInterval(4)) == 3)
        #expect(try anchor.map(nativeTimestamp: 102) == epoch.addingTimeInterval(2))
    }

    @Test func derivedTimesShareVerifiedOffset() throws {
        let epoch = Date(timeIntervalSince1970: 1_700_000_000)
        let anchor = try TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: 100,
                                             verifiedOffsetSeconds: 40)
        let measured = try anchor.map(nativeTimestamp: 101)
        #expect(try anchor.mapDerived(nativeTimestamp: 100.5, owningNativeTimestamp: 101,
                                      owningMeasuredAt: measured) == measured.addingTimeInterval(-0.5))
    }
}

struct TrackingJSONCodecTests {
    @Test func fractionalDatesRoundTripAndLegacyDatesDecode() throws {
        let epoch = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try TrackingJSONCodec.makeEncoder().encode(
            TrackingDateFixture(date: epoch.addingTimeInterval(0.123)))
        let second = try TrackingJSONCodec.makeEncoder().encode(
            TrackingDateFixture(date: epoch.addingTimeInterval(0.143)))
        #expect(first != second)
        let decoded = try TrackingJSONCodec.makeDecoder().decode(TrackingDateFixture.self, from: first)
        #expect(abs(decoded.date.timeIntervalSince(epoch.addingTimeInterval(0.123))) < 0.001)
        let legacy = Data("{\"date\":\"2023-11-14T22:13:20Z\"}".utf8)
        #expect(try TrackingJSONCodec.makeDecoder().decode(TrackingDateFixture.self,
                                                           from: legacy).date == epoch)
    }
}

private final class AdmissionRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; entries.append(value) }
    func values() -> [String] { lock.lock(); defer { lock.unlock() }; return entries }
}

struct CaptureIngressTests {
    @Test func concurrentAdmissionsDrainBeforeStopAndRejectOldGeneration() throws {
        let queue = DispatchQueue(label: "TrackingInfrastructureTests.ingress")
        let ingress = TrackingCaptureIngress(processorQueue: queue)
        let recorder = AdmissionRecorder()
        let context = TrackingCaptureContext(sessionID: UUID(), streamSegmentID: UUID(), generation: UUID())
        try ingress.open(context)
        DispatchQueue.concurrentPerform(iterations: 100) { _ in
            #expect(ingress.submit(context: context) { recorder.append(String($0.ordinal)) })
        }
        try ingress.close(context: context) { recorder.append("stop:\($0.lastAdmissionOrdinal)") }
        #expect(!ingress.submit(context: context) { _ in })
        queue.sync {}
        #expect(recorder.values() == (1...100).map(String.init) + ["stop:100"])
    }
}

struct TrackingRatePolicyTests {
    @Test func supportedRegularRatesQualifyAndSparseInputDoesNot() throws {
        for rate in [10, 20, 50] {
            let policy = try TrackingRatePolicy(nominalHz: rate)
            let timestamps = (0...Int(Double(rate) * 2.5)).map { Double($0) / Double(rate) }
            #expect(policy.evaluate(originalTimestamps: timestamps).eligible)
        }
        let policy = try TrackingRatePolicy(nominalHz: 50)
        #expect(!policy.evaluate(originalTimestamps: (0...25).map { Double($0) * 0.1 }).eligible)
        #expect(!policy.evaluate(originalTimestamps: [0, 0.02, 0.02, 0.04]).eligible)
    }
}
