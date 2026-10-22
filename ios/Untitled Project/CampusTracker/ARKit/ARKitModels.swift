import Foundation

/// Mirrors the `trackingState` enum the server's ARKit ingest schema accepts. Separate from
/// ARKit's own `ARCamera.TrackingState` so the networking/model layer doesn't need to import ARKit.
nonisolated enum ARKitTrackingState: String, Codable, Sendable {
    case normal
    case limited
    case notAvailable
}

/// Local-only detail on *why* tracking is limited. Not part of the server's wire contract
/// (kept out of the strict `arkit.pose` payload schema), used for on-device diagnostics only.
nonisolated enum ARKitTrackingStateReason: String, Codable, Sendable {
    case initializing
    case excessiveMotion
    case insufficientFeatures
    case relocalizing
}

nonisolated enum ARKitPoseRate: Int, Codable, CaseIterable, Identifiable, Sendable {
    case hz5 = 5, hz10 = 10, hz20 = 20
    var id: Int { rawValue }
    var interval: TimeInterval { 1.0 / Double(rawValue) }
    var label: String { "\(rawValue) Hz" }
}

/// A single ARKit camera pose, as extracted from one `ARFrame`. Deliberately has no wall-clock
/// `timestamp`: ARFrame.timestamp shares CoreMotion's boot-relative clock, so callers convert it
/// using the ARKit stream's fixed `TrackingClockAnchor` (see `CollectionCore`).
nonisolated struct ARKitPoseSample: Codable, Sendable {
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
