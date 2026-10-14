import Foundation

/// Mirrors the `trackingState` enum the server's ARKit ingest schema accepts. Separate from
/// ARKit's own `ARCamera.TrackingState` so the networking/model layer doesn't need to import ARKit.
enum ARKitTrackingState: String, Codable {
    case normal
    case limited
    case notAvailable
}

/// Local-only detail on *why* tracking is limited. Not part of the server's wire contract
/// (kept out of the strict `arkit.pose` payload schema), used for on-device diagnostics only.
enum ARKitTrackingStateReason: String, Codable {
    case initializing
    case excessiveMotion
    case insufficientFeatures
    case relocalizing
}

enum ARKitPoseRate: Int, Codable, CaseIterable, Identifiable {
    case hz5 = 5, hz10 = 10, hz20 = 20
    var id: Int { rawValue }
    var interval: TimeInterval { 1.0 / Double(rawValue) }
    var label: String { "\(rawValue) Hz" }
}

/// A single ARKit camera pose, as extracted from one `ARFrame`. Deliberately has no wall-clock
/// `timestamp`: ARFrame.timestamp shares CoreMotion's boot-relative clock, so callers convert it
/// using the same `bootTime` offset already used for `MotionSample`/`AltimeterSample`.
struct ARKitPoseSample {
    let arSessionId: UUID
    let sequence: Int
    let frameTimestamp: TimeInterval
    let positionX: Double
    let positionY: Double
    let positionZ: Double
    let rotationX: Double
    let rotationY: Double
    let rotationZ: Double
    let rotationW: Double
    let trackingState: ARKitTrackingState
    let trackingStateReason: ARKitTrackingStateReason?
}
