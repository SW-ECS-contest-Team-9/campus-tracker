"""Read-only Swift probes for the iOS tracking review (not device accuracy tests).

Run from any directory: python3 /absolute/path/to/this/probe.py
Only the adjacent results.json and an isolated temporary directory are written.
The estimator and clock corrector are extracted from the current worktree unchanged.
"""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "ios/Untitled Project/CampusTracker"
coordinator_path = APP / "Services/CollectionCoordinator.swift"
estimator_path = APP / "Services/WalkingFrameEstimator.swift"
repository_path = APP / "Persistence/SensorDataRepository.swift"
coordinator = coordinator_path.read_text()
start = coordinator.index("final class BootTimeDriftCorrector {")
end = coordinator.index("\n@MainActor", start)
corrector = coordinator[start:end]
estimator = estimator_path.read_text()

DRIVER = r'''
let baseline = Date(timeIntervalSince1970: 1_700_000_000)
let delayed = BootTimeDriftCorrector()
let first = delayed.convert(rawTimestamp: 100, bootTime: baseline, now: baseline.addingTimeInterval(103))
let second = delayed.convert(rawTimestamp: 101, bootTime: baseline, now: baseline.addingTimeInterval(103.1))
print("clock_delayed_first_callback_s=\(first.date.timeIntervalSince(baseline.addingTimeInterval(100)))")
print("clock_later_sample_shift_s=\(second.date.timeIntervalSince(baseline.addingTimeInterval(101)))")

// The direct walking-frame mapping duplicates record(motion:)'s current expression;
// it is a mapping probe, not an invocation of Core Motion or CollectionCoordinator.
let offsetClock = BootTimeDriftCorrector()
let motion = offsetClock.convert(rawTimestamp: 100, bootTime: baseline, now: baseline.addingTimeInterval(140))
let walkingEstimatedAt = baseline.addingTimeInterval(100)
print("motion_minus_walking_estimated_at_s=\(motion.date.timeIntervalSince(walkingEstimatedAt))")

// Match LocalSensorDataRepository's current JSONEncoder date strategy.
struct Stamp: Codable { let timestamp: Date }
let encoder = JSONEncoder()
encoder.dateEncodingStrategy = .iso8601
let exportA = try encoder.encode(Stamp(timestamp: baseline.addingTimeInterval(0.123)))
let exportB = try encoder.encode(Stamp(timestamp: baseline.addingTimeInterval(0.143)))
print("export_20ms_apart_equal=\(exportA == exportB)")
print("export_example=\(String(decoding: exportA, as: UTF8.self))")

// Twenty seconds of a stable, synthetic 1.8 Hz horizontal oscillation.
// This tests sample-window eligibility, not the accuracy of human walking direction.
for hz in [10, 20, 50] {
    var estimator = WalkingFrameEstimator()
    var maxCount = 0, axisCount = 0, snapshots = 0
    for index in 0..<(hz * 20) {
        let t = Double(index) / Double(hz)
        let input = WalkingFrameInput(sensorTimestamp: t,
            userAcceleration: Vector3D(x: 0.2 * sin(2 * .pi * 1.8 * t), y: 0, z: 0),
            gravity: Vector3D(x: 0, y: 0, z: -1), rotationRate: .zero,
            attitudeQuaternion: .identity, magneticField: nil, sensorSegmentId: "audit")
        if let result = estimator.process(input) {
            snapshots += 1
            maxCount = max(maxCount, result.sampleCount)
            if result.status == .axisEstimated { axisCount += 1 }
        }
    }
    print("walking_hz=\(hz) max_samples=\(maxCount) axis_estimated=\(axisCount)/\(snapshots)")
}
'''

with tempfile.TemporaryDirectory(prefix="campus-ios-tracking-") as temporary:
    directory = Path(temporary)
    main = directory / "main.swift"
    binary = directory / "probe"
    main.write_text(estimator + "\n" + corrector + "\n" + DRIVER)
    subprocess.run(
        ["swiftc", "-module-cache-path", str(directory / "module-cache"),
         str(main), "-o", str(binary)], check=True,
    )
    result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)

evidence = {
    "review_date_kst": "2026-10-14",
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "source_is_worktree_not_clean_head": True,
    "swift_version": subprocess.check_output(["swiftc", "--version"], text=True).strip(),
    "source_sha256": {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (coordinator_path, estimator_path, repository_path)
    },
    "scope": "Host-side pure Swift probes; no iOS build, device sensors, network, or production DB.",
    "output": result.stdout.splitlines(),
}
Path(__file__).with_name("results.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
print(json.dumps(evidence, indent=2, ensure_ascii=False))
