// Host-side check driver; run_reference_checks.py copies this file to main.swift.
import Foundation

nonisolated final class ProbeRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; entries.append(value) }
    func values() -> [String] { lock.lock(); defer { lock.unlock() }; return entries }
}
nonisolated enum ProbeFailure: Error { case storage, assertion }
nonisolated func throwingAssert(_ condition: @autoclosure () throws -> Bool) throws {
    let result = try condition()
    if !result { throw ProbeFailure.assertion }
}
nonisolated struct Stamp: Codable { let date: Date }

let epoch = Date(timeIntervalSince1970: 1_700_000_000)
let anchor = try TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: 100)
let measured = try anchor.map(nativeTimestamp: 101)
assert(measured == epoch.addingTimeInterval(1))
try throwingAssert(try anchor.deliveryResidual(nativeTimestamp: 101, callbackEpoch: epoch.addingTimeInterval(4)) == 3)
try throwingAssert(try anchor.map(nativeTimestamp: 102) == epoch.addingTimeInterval(2))
let offset = try TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: 100, verifiedOffsetSeconds: 40)
let owning = try offset.map(nativeTimestamp: 101)
try throwingAssert(try offset.mapDerived(nativeTimestamp: 101, owningNativeTimestamp: 101, owningMeasuredAt: owning) == owning)
print("PASS clock: callback latency does not change mapping; derived timestamp shares verified offset")

let dataA = try TrackingJSONCodec.makeEncoder().encode(Stamp(date: epoch.addingTimeInterval(0.123)))
let dataB = try TrackingJSONCodec.makeEncoder().encode(Stamp(date: epoch.addingTimeInterval(0.143)))
assert(dataA != dataB)
let roundTrip = try TrackingJSONCodec.makeDecoder().decode(Stamp.self, from: dataA)
assert(abs(roundTrip.date.timeIntervalSince(epoch.addingTimeInterval(0.123))) < 0.001)
let legacy = Data("{\"date\":\"2023-11-14T22:13:20Z\"}".utf8)
try throwingAssert(try TrackingJSONCodec.makeDecoder().decode(Stamp.self, from: legacy).date == epoch)
print("PASS JSON: 20 ms timestamps remain distinct; old whole-second strings decode")

var allocator = try TrackingSequenceAllocator(snapshotLastIssued: 0, durableLastRecorded: -1, reservedExclusive: 0)
do { _ = try allocator.issue { _ in throw ProbeFailure.storage }; assertionFailure() } catch {}
assert(allocator.lastIssued == 0 && allocator.reservedExclusive == 0)
let issued = try allocator.issue { assert($0 == 201) }
assert(issued == 1)
var recovered = try TrackingSequenceAllocator(snapshotLastIssued: 10, durableLastRecorded: 7, reservedExclusive: 201)
try throwingAssert(try recovered.issue { assert($0 == 401) } == 201)
print("PASS sequence: failed reservation issues nothing; recovery skips the entire old reservation")

for hz in [10, 20, 50] {
    let policy = try TrackingRatePolicy(nominalHz: hz)
    let times = (0...Int(Double(hz) * 2.5)).map { Double($0) / Double(hz) }
    assert(policy.evaluate(originalTimestamps: times).eligible)
}
let policy50 = try TrackingRatePolicy(nominalHz: 50)
assert(!policy50.evaluate(originalTimestamps: (0...25).map { Double($0) * 0.1 }).eligible)
assert(!policy50.evaluate(originalTimestamps: [0, 0.02, 0.02, 0.04]).eligible)
print("PASS rate: regular 10/20/50 Hz windows qualify; sparse or duplicate input does not")

let queue = DispatchQueue(label: "reference.probe")
let ingress = TrackingCaptureIngress(processorQueue: queue)
let recorder = ProbeRecorder()
let first = TrackingCaptureContext(sessionID: UUID(), streamSegmentID: UUID(), generation: UUID())
try ingress.open(first)
assert(ingress.submit(context: first) { [recorder] in recorder.append("sample:\($0.ordinal)") })
assert(ingress.submit(context: first) { [recorder] in recorder.append("sample:\($0.ordinal)") })
try ingress.close(context: first) { [recorder] in recorder.append("stop:\($0.lastAdmissionOrdinal)") }
assert(!ingress.submit(context: first) { _ in assertionFailure() })
let second = TrackingCaptureContext(sessionID: UUID(), streamSegmentID: UUID(), generation: UUID())
try ingress.open(second)
assert(!ingress.submit(context: first) { _ in assertionFailure() })
assert(ingress.submit(context: second) { [recorder] in recorder.append("new:\($0.ordinal)") })
try ingress.close(context: second) { [recorder] in recorder.append("newstop:\($0.lastAdmissionOrdinal)") }
queue.sync {}
assert(recorder.values() == ["sample:1", "sample:2", "stop:2", "new:1", "newstop:1"])
print("PASS ingress: stop follows all admitted samples; closed generations cannot enter a new run")

let parallelQueue = DispatchQueue(label: "reference.parallel-probe")
let parallelIngress = TrackingCaptureIngress(processorQueue: parallelQueue)
let parallelRecorder = ProbeRecorder()
let parallelContext = TrackingCaptureContext(sessionID: UUID(), streamSegmentID: UUID(), generation: UUID())
try parallelIngress.open(parallelContext)
DispatchQueue.concurrentPerform(iterations: 1000) { [parallelIngress, parallelRecorder, parallelContext] _ in
    assert(parallelIngress.submit(context: parallelContext) { [parallelRecorder] in
        parallelRecorder.append(String($0.ordinal))
    })
}
try parallelIngress.close(context: parallelContext) { [parallelRecorder] in
    parallelRecorder.append("stop:\($0.lastAdmissionOrdinal)")
}
parallelQueue.sync {}
assert(parallelRecorder.values() == (1...1000).map(String.init) + ["stop:1000"])
print("PASS concurrent ingress: 1000 concurrent admissions execute in ordinal order before the stop barrier")

let ticket = TrackingRequestTicket(requestID: UUID(), itemID: "batch", sessionID: UUID(), collectorID: "C04", serverKey: "server", connectionGeneration: 1)
var gate = TrackingDispatchGate(connected: true, hasOwner: true, inFlight: nil, retryNotBeforeUptime: 3)
assert(!gate.mayPump(nowUptime: 2))
assert(gate.mayPump(nowUptime: 3))
gate.inFlight = ticket
assert(!gate.mayPump(nowUptime: 4))
assert(gate.maySend(encodedTicket: ticket, currentConnectionGeneration: 1, currentCollectorID: "C04", currentServerKey: "server"))
assert(!gate.maySend(encodedTicket: ticket, currentConnectionGeneration: 2, currentCollectorID: "C04", currentServerKey: "server"))
assert(!gate.maySend(encodedTicket: ticket, currentConnectionGeneration: 1, currentCollectorID: "C02", currentServerKey: "server"))
print("PASS dispatch: backoff, single-flight, generation and owner guards")
