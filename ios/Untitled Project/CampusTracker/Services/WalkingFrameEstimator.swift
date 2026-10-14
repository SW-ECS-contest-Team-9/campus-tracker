import Foundation

nonisolated struct Vector3D: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let z: Double

    static let zero = Vector3D(x: 0, y: 0, z: 0)
    var magnitude: Double { sqrt(x * x + y * y + z * z) }
    func dot(_ other: Self) -> Double { x * other.x + y * other.y + z * other.z }
    func cross(_ other: Self) -> Self {
        Self(x: y * other.z - z * other.y, y: z * other.x - x * other.z, z: x * other.y - y * other.x)
    }
    func normalized() -> Self? {
        let length = magnitude
        guard length.isFinite, length > 1e-9 else { return nil }
        return self / length
    }
    static prefix func - (value: Self) -> Self { Self(x: -value.x, y: -value.y, z: -value.z) }
    static func + (lhs: Self, rhs: Self) -> Self { Self(x: lhs.x + rhs.x, y: lhs.y + rhs.y, z: lhs.z + rhs.z) }
    static func - (lhs: Self, rhs: Self) -> Self { Self(x: lhs.x - rhs.x, y: lhs.y - rhs.y, z: lhs.z - rhs.z) }
    static func * (lhs: Self, rhs: Double) -> Self { Self(x: lhs.x * rhs, y: lhs.y * rhs, z: lhs.z * rhs) }
    static func / (lhs: Self, rhs: Double) -> Self { Self(x: lhs.x / rhs, y: lhs.y / rhs, z: lhs.z / rhs) }
}

/// Unit quaternion using Hamilton multiplication. `rotated(_:)` is an active, right-handed
/// rotation: q * (0,v) * q^-1. In this estimator q maps device coordinates into the current
/// gyro/gravity-relative estimator reference.
nonisolated struct QuaternionD: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let z: Double
    let w: Double

    static let identity = Self(x: 0, y: 0, z: 0, w: 1)
    func normalized() -> Self {
        let length = sqrt(x * x + y * y + z * z + w * w)
        guard length.isFinite, length > 1e-12 else { return .identity }
        return Self(x: x / length, y: y / length, z: z / length, w: w / length)
    }
    var inverse: Self { Self(x: -x, y: -y, z: -z, w: w).normalized() }
    static func * (lhs: Self, rhs: Self) -> Self {
        Self(
            x: lhs.w * rhs.x + lhs.x * rhs.w + lhs.y * rhs.z - lhs.z * rhs.y,
            y: lhs.w * rhs.y - lhs.x * rhs.z + lhs.y * rhs.w + lhs.z * rhs.x,
            z: lhs.w * rhs.z + lhs.x * rhs.y - lhs.y * rhs.x + lhs.z * rhs.w,
            w: lhs.w * rhs.w - lhs.x * rhs.x - lhs.y * rhs.y - lhs.z * rhs.z
        ).normalized()
    }
    func rotated(_ vector: Vector3D) -> Vector3D {
        let q = normalized()
        let u = Vector3D(x: q.x, y: q.y, z: q.z)
        return vector + u.cross(vector) * (2 * q.w) + u.cross(u.cross(vector)) * 2
    }
    static func rotationVector(_ vector: Vector3D) -> Self {
        let angle = vector.magnitude
        guard angle > 1e-12, let axis = vector.normalized() else { return .identity }
        let half = angle / 2
        return Self(x: axis.x * sin(half), y: axis.y * sin(half), z: axis.z * sin(half), w: cos(half))
    }
    static func aligning(_ from: Vector3D, to: Vector3D) -> Self {
        guard let a = from.normalized(), let b = to.normalized() else { return .identity }
        let cosine = max(-1, min(1, a.dot(b)))
        if cosine > 0.999999 { return .identity }
        if cosine < -0.999999 {
            let fallback = abs(a.x) < 0.8 ? Vector3D(x: 1, y: 0, z: 0) : Vector3D(x: 0, y: 1, z: 0)
            let axis = a.cross(fallback).normalized() ?? Vector3D(x: 0, y: 0, z: 1)
            return rotationVector(axis * .pi)
        }
        let cross = a.cross(b)
        return Self(x: cross.x, y: cross.y, z: cross.z, w: 1 + cosine).normalized()
    }
    var angle: Double { 2 * acos(max(-1, min(1, abs(normalized().w)))) }
}

nonisolated enum MagneticCalibrationQuality: String, Codable, Sendable {
    case uncalibrated = "UNCALIBRATED"
    case low = "LOW"
    case medium = "MEDIUM"
    case high = "HIGH"
    case unavailable = "UNAVAILABLE"
}

nonisolated struct CalibratedMagneticFieldSample: Codable, Equatable, Sendable {
    static let unit = "uT"
    static let source = "CORE_MOTION_CALIBRATED"
    let x: Double
    let y: Double
    let z: Double
    let accuracy: MagneticCalibrationQuality
    var magnitude: Double { sqrt(x * x + y * y + z * z) }
}

nonisolated enum WalkingFrameStatus: String, Codable, Sendable {
    case unknown = "UNKNOWN"
    case axisEstimated = "AXIS_ESTIMATED"
    case ambiguous = "AMBIGUOUS"
    case poseTransition = "POSE_TRANSITION"
}

nonisolated struct WalkingFrameSnapshot: Codable, Equatable, Sendable {
    static let schemaVersion = 1
    let schemaVersion: Int
    let algorithmVersion: String
    let frameId: UUID
    let reference: String
    let estimatedAtSensorTimestamp: TimeInterval
    let windowStartSensorTimestamp: TimeInterval
    let windowEndSensorTimestamp: TimeInterval
    let status: WalkingFrameStatus
    /// Unit horizontal axis expressed in the device coordinates at `estimatedAt`. Its negation is
    /// an equally valid candidate unless `directionResolved` is true.
    let axisDevice: Vector3D?
    let directionResolved: Bool
    let ambiguity: String
    /// Internal signal-quality score, not a probability or measured angular accuracy.
    let confidence: Double
    let eigenvalueRatio: Double?
    let horizontalEnergyG2: Double
    let periodicity: Double
    let axisConsistency: Double?
    let poseChangeRadians: Double
    let sampleCount: Int
    let expiresAtSensorTimestamp: TimeInterval
}

nonisolated struct WalkingFrameInput: Sendable {
    let sensorTimestamp: TimeInterval
    let userAcceleration: Vector3D
    let gravity: Vector3D
    let rotationRate: Vector3D
    let attitudeQuaternion: QuaternionD
    let magneticField: CalibratedMagneticFieldSample?
    let sensorSegmentId: String
}

nonisolated struct WalkingFrameEstimatorConfiguration: Codable, Equatable, Sendable {
    static let algorithmVersion = "gravity_gyro_pca_v1"
    var windowDuration: TimeInterval = 2.5
    var updateInterval: TimeInterval = 0.2
    var minimumSamples = 75
    var minimumHorizontalEnergyG2 = 0.0015
    var minimumEigenvalueRatio = 1.8
    var minimumPeriodicity = 0.08
    var poseTransitionAngleRadians = 25 * .pi / 180
    var poseTransitionHoldDuration: TimeInterval = 0.8
    var maximumSampleGap: TimeInterval = 0.25
    var staleAfter: TimeInterval = 1.0
    var gravityCorrectionGain = 0.015
    /// Broad diagnostic range only. Local building steel and device bias can legitimately exceed
    /// it; crossing it lowers quality but does not assert a hardware fault or disturbance.
    var plausibleMagneticMagnitudeMicrotesla: ClosedRange<Double> = 20...100
}

/// Sequential, timestamp-driven estimator. It never integrates acceleration into velocity or
/// position and never treats the PCA axis as a signed walking direction.
nonisolated struct WalkingFrameEstimator: Sendable {
    private struct Sample: Sendable {
        let timestamp: TimeInterval
        let horizontalReference: Vector3D
    }

    let configuration: WalkingFrameEstimatorConfiguration
    private(set) var frameId = UUID()
    private(set) var latestSnapshot: WalkingFrameSnapshot?
    private(set) var latestMagneticQuality: MagneticCalibrationQuality = .unavailable
    private var samples: [Sample] = []
    private var referenceFromDevice = QuaternionD.identity
    private var previousTimestamp: TimeInterval?
    private var previousAttitude: QuaternionD?
    private var previousAxisReference: Vector3D?
    private var lastEstimateTimestamp: TimeInterval?
    private var transitionUntil: TimeInterval?
    private var segmentId: String?

    init(configuration: WalkingFrameEstimatorConfiguration = .init()) {
        self.configuration = configuration
    }

    mutating func reset(reason: String? = nil) {
        frameId = UUID()
        samples.removeAll(keepingCapacity: true)
        referenceFromDevice = .identity
        previousTimestamp = nil
        previousAttitude = nil
        previousAxisReference = nil
        lastEstimateTimestamp = nil
        transitionUntil = nil
        latestSnapshot = nil
        segmentId = nil
    }

    mutating func process(_ input: WalkingFrameInput) -> WalkingFrameSnapshot? {
        guard input.sensorTimestamp.isFinite,
              input.userAcceleration.magnitude.isFinite,
              let upDevice = (-input.gravity).normalized() else { return nil }

        if segmentId != input.sensorSegmentId {
            reset()
            segmentId = input.sensorSegmentId
            referenceFromDevice = initialReference(upDevice: upDevice)
        }
        if let previousTimestamp {
            let dt = input.sensorTimestamp - previousTimestamp
            if dt <= 0 || dt > configuration.maximumSampleGap {
                reset()
                segmentId = input.sensorSegmentId
                referenceFromDevice = initialReference(upDevice: upDevice)
            } else {
                referenceFromDevice = referenceFromDevice * .rotationVector(input.rotationRate * dt)
                // Gravity may correct pitch/roll drift only. The aligning rotation contains no
                // deliberate yaw reference and is applied with a small complementary gain.
                let predictedUp = referenceFromDevice.rotated(upDevice)
                let correction = QuaternionD.aligning(predictedUp, to: Vector3D(x: 0, y: 0, z: 1))
                referenceFromDevice = .rotationVector(rotationVector(of: correction) * configuration.gravityCorrectionGain) * referenceFromDevice
            }
        }
        self.previousTimestamp = input.sensorTimestamp

        let attitudeChange = previousAttitude.map { ($0.inverse * input.attitudeQuaternion).angle } ?? 0
        previousAttitude = input.attitudeQuaternion
        if attitudeChange >= configuration.poseTransitionAngleRadians {
            samples.removeAll(keepingCapacity: true)
            previousAxisReference = nil
            transitionUntil = input.sensorTimestamp + configuration.poseTransitionHoldDuration
        }

        latestMagneticQuality = assessedMagneticQuality(input.magneticField)
        let horizontalDevice = input.userAcceleration - upDevice * input.userAcceleration.dot(upDevice)
        let horizontalReference = referenceFromDevice.rotated(horizontalDevice)
        samples.append(Sample(timestamp: input.sensorTimestamp, horizontalReference: horizontalReference))
        samples.removeAll { input.sensorTimestamp - $0.timestamp > configuration.windowDuration }

        guard lastEstimateTimestamp == nil || input.sensorTimestamp - (lastEstimateTimestamp ?? 0) >= configuration.updateInterval else { return nil }
        lastEstimateTimestamp = input.sensorTimestamp
        let snapshot = estimate(at: input.sensorTimestamp, currentUpDevice: upDevice, poseChange: attitudeChange)
        latestSnapshot = snapshot
        return snapshot
    }

    private mutating func estimate(at timestamp: TimeInterval, currentUpDevice: Vector3D, poseChange: Double) -> WalkingFrameSnapshot {
        let start = samples.first?.timestamp ?? timestamp
        let inTransition = (transitionUntil ?? -.infinity) > timestamp
        guard !inTransition, samples.count >= configuration.minimumSamples else {
            return snapshot(timestamp: timestamp, start: start, status: inTransition ? .poseTransition : .unknown,
                            axis: nil, confidence: 0, ratio: nil, energy: 0, periodicity: 0,
                            consistency: nil, poseChange: poseChange)
        }
        let points = samples.map { Vector3D(x: $0.horizontalReference.x, y: $0.horizontalReference.y, z: 0) }
        let meanX = points.reduce(0) { $0 + $1.x } / Double(points.count)
        let meanY = points.reduce(0) { $0 + $1.y } / Double(points.count)
        var cxx = 0.0, cxy = 0.0, cyy = 0.0
        for point in points {
            let x = point.x - meanX, y = point.y - meanY
            cxx += x * x; cxy += x * y; cyy += y * y
        }
        let divisor = Double(max(1, points.count - 1))
        cxx /= divisor; cxy /= divisor; cyy /= divisor
        let trace = cxx + cyy
        let root = sqrt(max(0, (cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy))
        let major = max(0, (trace + root) / 2), minor = max(0, (trace - root) / 2)
        let ratio = major / max(minor, 1e-9)
        let energy = trace
        let angle = 0.5 * atan2(2 * cxy, cxx - cyy)
        let axisReference = Vector3D(x: cos(angle), y: sin(angle), z: 0)
        let consistency = previousAxisReference.map { abs($0.dot(axisReference)) }
        let periodicity = periodicityScore(points: points, meanX: meanX, meanY: meanY)
        guard energy >= configuration.minimumHorizontalEnergyG2 else {
            return snapshot(timestamp: timestamp, start: start, status: .unknown, axis: nil,
                            confidence: 0, ratio: ratio, energy: energy, periodicity: periodicity,
                            consistency: consistency, poseChange: poseChange)
        }
        guard ratio >= configuration.minimumEigenvalueRatio, periodicity >= configuration.minimumPeriodicity else {
            return snapshot(timestamp: timestamp, start: start, status: .ambiguous, axis: nil,
                            confidence: min(0.35, energy / configuration.minimumHorizontalEnergyG2 * 0.1),
                            ratio: ratio, energy: energy, periodicity: periodicity,
                            consistency: consistency, poseChange: poseChange)
        }
        previousAxisReference = axisReference
        let confidence = min(1, max(0,
            0.35 * min(1, (ratio - 1) / 4)
            + 0.25 * min(1, energy / (configuration.minimumHorizontalEnergyG2 * 4))
            + 0.20 * periodicity
            + 0.20 * (consistency ?? 0.5)))
        let axisDevice = referenceFromDevice.inverse.rotated(axisReference)
        let horizontalAxis = (axisDevice - currentUpDevice * axisDevice.dot(currentUpDevice)).normalized()
        return snapshot(timestamp: timestamp, start: start, status: .axisEstimated, axis: horizontalAxis,
                        confidence: confidence, ratio: ratio, energy: energy, periodicity: periodicity,
                        consistency: consistency, poseChange: poseChange)
    }

    private func snapshot(timestamp: TimeInterval, start: TimeInterval, status: WalkingFrameStatus,
                          axis: Vector3D?, confidence: Double, ratio: Double?, energy: Double,
                          periodicity: Double, consistency: Double?, poseChange: Double) -> WalkingFrameSnapshot {
        WalkingFrameSnapshot(schemaVersion: WalkingFrameSnapshot.schemaVersion,
            algorithmVersion: WalkingFrameEstimatorConfiguration.algorithmVersion,
            frameId: frameId, reference: "GYRO_GRAVITY_RELATIVE",
            estimatedAtSensorTimestamp: timestamp, windowStartSensorTimestamp: start,
            windowEndSensorTimestamp: timestamp, status: status, axisDevice: axis,
            directionResolved: false, ambiguity: "AXIS_180", confidence: confidence,
            eigenvalueRatio: ratio, horizontalEnergyG2: energy, periodicity: periodicity,
            axisConsistency: consistency, poseChangeRadians: poseChange, sampleCount: samples.count,
            expiresAtSensorTimestamp: timestamp + configuration.staleAfter)
    }

    private func initialReference(upDevice: Vector3D) -> QuaternionD {
        let preferred = abs(upDevice.x) < 0.9 ? Vector3D(x: 1, y: 0, z: 0) : Vector3D(x: 0, y: 1, z: 0)
        let e1 = (preferred - upDevice * preferred.dot(upDevice)).normalized() ?? Vector3D(x: 1, y: 0, z: 0)
        let e2 = upDevice.cross(e1).normalized() ?? Vector3D(x: 0, y: 1, z: 0)
        // Rows [e1,e2,up] form the right-handed device->reference basis.
        return quaternionFromRows(e1, e2, upDevice)
    }

    private func quaternionFromRows(_ r0: Vector3D, _ r1: Vector3D, _ r2: Vector3D) -> QuaternionD {
        let trace = r0.x + r1.y + r2.z
        if trace > 0 {
            let s = sqrt(trace + 1) * 2
            return QuaternionD(x: (r2.y - r1.z) / s, y: (r0.z - r2.x) / s, z: (r1.x - r0.y) / s, w: s / 4).normalized()
        } else if r0.x > r1.y && r0.x > r2.z {
            let s = sqrt(1 + r0.x - r1.y - r2.z) * 2
            return QuaternionD(x: s / 4, y: (r0.y + r1.x) / s, z: (r0.z + r2.x) / s, w: (r2.y - r1.z) / s).normalized()
        } else if r1.y > r2.z {
            let s = sqrt(1 + r1.y - r0.x - r2.z) * 2
            return QuaternionD(x: (r0.y + r1.x) / s, y: s / 4, z: (r1.z + r2.y) / s, w: (r0.z - r2.x) / s).normalized()
        }
        let s = sqrt(1 + r2.z - r0.x - r1.y) * 2
        return QuaternionD(x: (r0.z + r2.x) / s, y: (r1.z + r2.y) / s, z: s / 4, w: (r1.x - r0.y) / s).normalized()
    }

    private func rotationVector(of quaternion: QuaternionD) -> Vector3D {
        let q = quaternion.normalized(), angle = q.angle
        let sine = sqrt(max(0, 1 - q.w * q.w))
        guard sine > 1e-9 else { return .zero }
        return Vector3D(x: q.x / sine, y: q.y / sine, z: q.z / sine) * angle
    }

    private func periodicityScore(points: [Vector3D], meanX: Double, meanY: Double) -> Double {
        guard points.count >= 20 else { return 0 }
        let projected = points.map { hypot($0.x - meanX, $0.y - meanY) }
        let mean = projected.reduce(0, +) / Double(projected.count)
        let centered = projected.map { $0 - mean }
        let variance = centered.reduce(0) { $0 + $1 * $1 }
        guard variance > 1e-9 else { return 0 }
        let duration = max(1e-6, (samples.last?.timestamp ?? 0) - (samples.first?.timestamp ?? 0))
        let rate = Double(points.count - 1) / duration
        let minLag = max(2, Int(rate / 3.0)), maxLag = min(points.count / 2, Int(rate / 1.0))
        guard minLag <= maxLag else { return 0 }
        var best = 0.0
        for lag in minLag...maxLag {
            var sum = 0.0
            for index in lag..<centered.count { sum += centered[index] * centered[index - lag] }
            best = max(best, sum / variance)
        }
        return max(0, min(1, best))
    }

    private func assessedMagneticQuality(_ field: CalibratedMagneticFieldSample?) -> MagneticCalibrationQuality {
        guard let field, field.magnitude.isFinite else { return .unavailable }
        guard configuration.plausibleMagneticMagnitudeMicrotesla.contains(field.magnitude) else { return .low }
        return field.accuracy
    }
}
