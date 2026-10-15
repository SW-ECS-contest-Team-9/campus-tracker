import ARKit
import Foundation
import simd

/// Whether the service is currently driving a live `ARSession`, versus parked because the
/// collection session stopped or the app is backgrounded.
enum ARKitRunState {
    case stopped
    case running
    case pausedInBackground
}

/// Wraps a headless `ARSession` (no `ARSCNView`/`ARView` attached — only camera pose and
/// tracking quality are needed, not rendering) for world-tracking VIO collection.
///
/// Owns exactly one responsibility: run ARKit, rate-limit pose delivery, and decide when the
/// local coordinate frame has been invalidated (and therefore needs a new `arSessionId`).
/// Networking, persistence, and UI state all live in `CollectionCoordinator`, same as the other
/// sensor services in `SensorServices.swift`.
final class ARKitTrackingService: NSObject, ARSessionDelegate {
    /// LiDAR is irrelevant here: only world tracking support matters (see module instructions).
    static var isSupported: Bool { ARWorldTrackingConfiguration.isSupported }

    private let session = ARSession()
    private var rate: ARKitPoseRate = .hz10
    private var lastEmittedFrameTimestamp: TimeInterval = -.infinity
    private var sequence = 0

    private(set) var runState: ARKitRunState = .stopped
    private(set) var arSessionId = UUID()

    var isActive: Bool { runState == .running }

    var onPose: ((ARKitPoseSample) -> Void)?
    var onTrackingStateChanged: ((ARKitTrackingState, ARKitTrackingStateReason?) -> Void)?
    /// Fired whenever `arSessionId` changes, with the new id. The *only* signal consumers should
    /// use to know the local coordinate frame restarted.
    var onSessionReset: ((UUID) -> Void)?
    var onError: ((String) -> Void)?
    var onInterruption: ((Bool) -> Void)?

    override init() {
        super.init()
        session.delegate = self
    }

    func start(rate: ARKitPoseRate) {
        guard Self.isSupported, runState == .stopped else { return }
        beginFreshRun(rate: rate, options: [])
    }

    func updateRate(_ newRate: ARKitPoseRate) {
        rate = newRate
    }

    /// Suspends camera processing without tearing down tracking state. Used when the app moves
    /// to the background — ARKit cannot read the camera while backgrounded regardless.
    func pauseForBackground() {
        guard runState == .running else { return }
        session.pause()
        runState = .pausedInBackground
    }

    /// Always starts a new local coordinate frame: no camera frames were captured while
    /// backgrounded, so continuity with the pre-pause world origin can't be guaranteed. Using
    /// `.resetTracking` makes this deterministic rather than depending on whether ARKit's own
    /// relocalization happens to succeed.
    func resumeFromBackground(rate: ARKitPoseRate) {
        guard Self.isSupported, runState == .pausedInBackground else { return }
        beginFreshRun(rate: rate, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        guard runState != .stopped else { return }
        session.pause()
        runState = .stopped
    }

    private func beginFreshRun(rate: ARKitPoseRate, options: ARSession.RunOptions) {
        self.rate = rate
        sequence = 0
        lastEmittedFrameTimestamp = -.infinity
        arSessionId = UUID()
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        session.run(configuration, options: options)
        runState = .running
        onSessionReset?(arSessionId)
    }

    private static func trackingState(from state: ARCamera.TrackingState) -> (ARKitTrackingState, ARKitTrackingStateReason?) {
        switch state {
        case .normal:
            return (.normal, nil)
        case .notAvailable:
            return (.notAvailable, nil)
        case let .limited(reason):
            switch reason {
            case .initializing: return (.limited, .initializing)
            case .excessiveMotion: return (.limited, .excessiveMotion)
            case .insufficientFeatures: return (.limited, .insufficientFeatures)
            case .relocalizing: return (.limited, .relocalizing)
            @unknown default: return (.limited, nil)
            }
        @unknown default:
            return (.notAvailable, nil)
        }
    }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard runState == .running else { return }
        let frameTimestamp = frame.timestamp
        guard frameTimestamp - lastEmittedFrameTimestamp >= rate.interval else { return }
        lastEmittedFrameTimestamp = frameTimestamp
        sequence += 1

        let transform = frame.camera.transform
        // simd_quatf has no direct float4x4 initializer; drop the translation column to get the
        // 3x3 rotation submatrix it does accept.
        let rotationMatrix = simd_float3x3(
            SIMD3<Float>(transform.columns.0.x, transform.columns.0.y, transform.columns.0.z),
            SIMD3<Float>(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z),
            SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
        )
        let quaternion = simd_quatf(rotationMatrix).normalized
        let (state, reason) = Self.trackingState(from: frame.camera.trackingState)

        onPose?(ARKitPoseSample(
            arSessionId: arSessionId,
            sequence: sequence,
            frameTimestamp: frameTimestamp,
            positionX: Double(transform.columns.3.x),
            positionY: Double(transform.columns.3.y),
            positionZ: Double(transform.columns.3.z),
            rotationX: Double(quaternion.vector.x),
            rotationY: Double(quaternion.vector.y),
            rotationZ: Double(quaternion.vector.z),
            rotationW: Double(quaternion.vector.w),
            trackingState: state,
            trackingStateReason: reason
        ))
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let (state, reason) = Self.trackingState(from: camera.trackingState)
        onTrackingStateChanged?(state, reason)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        runState = .stopped
        onError?(error.localizedDescription)
    }

    func sessionWasInterrupted(_ session: ARSession) {
        onInterruption?(true)
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        onInterruption?(false)
    }

    /// Background/foreground transitions are handled explicitly via `pauseForBackground()` /
    /// `resumeFromBackground()`, which always force a clean reset. Returning `true` here only
    /// matters for interruptions *not* covered by that path (e.g. a brief phone call that never
    /// moves the app to the background scene phase) — in that narrower case, letting ARKit try
    /// to relocalize gives the local coordinate frame a chance to survive without our help.
    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }
}
