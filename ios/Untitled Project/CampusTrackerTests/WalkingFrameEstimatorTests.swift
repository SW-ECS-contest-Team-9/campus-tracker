import Foundation
import Testing
@testable import CampusTracker

private func testConfiguration() -> WalkingFrameEstimatorConfiguration {
    var configuration = WalkingFrameEstimatorConfiguration()
    configuration.windowDuration = 2
    configuration.updateInterval = 0.1
    configuration.minimumSamples = 40
    configuration.minimumHorizontalEnergyG2 = 0.0005
    configuration.minimumEigenvalueRatio = 1.5
    configuration.minimumPeriodicity = 0
    configuration.poseTransitionHoldDuration = 0.25
    return configuration
}

private func input(timestamp: Double, acceleration: Vector3D, gravity: Vector3D = Vector3D(x: 0, y: 0, z: -1),
                   gyro: Vector3D = .zero, attitude: QuaternionD = .identity, segment: String = "segment") -> WalkingFrameInput {
    WalkingFrameInput(sensorTimestamp: timestamp, userAcceleration: acceleration, gravity: gravity,
                      rotationRate: gyro, attitudeQuaternion: attitude, magneticField: nil,
                      sensorSegmentId: segment)
}

struct WalkingFrameMathTests {
    @Test func quaternionRotatesAndInverseRestoresVector() {
        let rotation = QuaternionD.rotationVector(Vector3D(x: 0, y: 0, z: .pi / 2))
        let rotated = rotation.rotated(Vector3D(x: 1, y: 0, z: 0))
        #expect(abs(rotated.x) < 1e-9)
        #expect(abs(rotated.y - 1) < 1e-9)
        let restored = rotation.inverse.rotated(rotated)
        #expect(abs(restored.x - 1) < 1e-9)
        #expect(abs(restored.y) < 1e-9)
        let xRotation = QuaternionD.rotationVector(Vector3D(x: .pi / 2, y: 0, z: 0))
        let xResult = xRotation.rotated(Vector3D(x: 0, y: 1, z: 0))
        #expect(abs(xResult.z - 1) < 1e-9)
        let yRotation = QuaternionD.rotationVector(Vector3D(x: 0, y: .pi / 2, z: 0))
        let yResult = yRotation.rotated(Vector3D(x: 0, y: 0, z: 1))
        #expect(abs(yResult.x - 1) < 1e-9)
    }

    @Test func gravityProjectionRemovesOnlyVerticalComponent() {
        let gravity = Vector3D(x: 0, y: 0, z: -1)
        let up = (-gravity).normalized()!
        let acceleration = Vector3D(x: 0.4, y: -0.2, z: 1.3)
        let horizontal = acceleration - up * acceleration.dot(up)
        #expect(abs(horizontal.x - 0.4) < 1e-12)
        #expect(abs(horizontal.y + 0.2) < 1e-12)
        #expect(abs(horizontal.z) < 1e-12)
    }

    @Test func angleWrapUsesShortestQuaternionRotation() {
        let a = QuaternionD.rotationVector(Vector3D(x: 0, y: 0, z: 179 * Double.pi / 180))
        let b = QuaternionD.rotationVector(Vector3D(x: 0, y: 0, z: -179 * Double.pi / 180))
        let delta = a.inverse * b
        #expect(abs(delta.angle - 2 * Double.pi / 180) < 1e-6)
    }
}

struct WalkingFrameEstimatorBehaviorTests {
    @Test func stationaryAndWeakSignalNeverInventAxis() {
        var estimator = WalkingFrameEstimator(configuration: testConfiguration())
        var last: WalkingFrameSnapshot?
        for index in 0..<150 {
            last = estimator.process(input(timestamp: Double(index) * 0.02, acceleration: .zero)) ?? last
        }
        #expect(last?.status == .unknown)
        #expect(last?.axisDevice == nil)
        #expect(last?.directionResolved == false)
    }

    @Test func phoneYawRotationPreservesPhysicalUnsignedAxisWithoutResolvingDirection() {
        var estimator = WalkingFrameEstimator(configuration: testConfiguration())
        var phoneYaw = 0.0
        var last: WalkingFrameSnapshot?
        for index in 0..<260 {
            let time = Double(index) * 0.02
            let rotating = index >= 100 && index < 150
            let yawRate = rotating ? Double.pi : 0 // 180° over one second
            phoneYaw += yawRate * 0.02
            let referenceFromDevice = QuaternionD.rotationVector(Vector3D(x: 0, y: 0, z: phoneYaw))
            let physicalAcceleration = Vector3D(x: 0.18 * sin(2 * .pi * 1.8 * time), y: 0, z: 0.04 * sin(2 * .pi * 3.6 * time))
            let deviceAcceleration = referenceFromDevice.inverse.rotated(physicalAcceleration)
            let snapshot = estimator.process(input(timestamp: time, acceleration: deviceAcceleration,
                                                     gyro: Vector3D(x: 0, y: 0, z: yawRate),
                                                     attitude: referenceFromDevice))
            last = snapshot ?? last
        }
        #expect(last?.status == .axisEstimated)
        #expect(last?.directionResolved == false)
        #expect(last?.ambiguity == "AXIS_180")
        if let axis = last?.axisDevice {
            let physicalAxis = QuaternionD.rotationVector(Vector3D(x: 0, y: 0, z: phoneYaw)).rotated(axis)
            #expect(abs(physicalAxis.x) > 0.9)
        } else {
            Issue.record("Expected an unsigned axis")
        }
    }

    @Test func abruptHandPoseChangeEntersTransitionThenReestimates() {
        var estimator = WalkingFrameEstimator(configuration: testConfiguration())
        var sawTransition = false
        var last: WalkingFrameSnapshot?
        for index in 0..<220 {
            let time = Double(index) * 0.02
            let attitude = index < 100 ? QuaternionD.identity : QuaternionD.rotationVector(Vector3D(x: .pi / 3, y: 0, z: 0))
            let acceleration = Vector3D(x: 0.2 * sin(2 * .pi * 1.7 * time), y: 0, z: 0)
            if let snapshot = estimator.process(input(timestamp: time, acceleration: acceleration, attitude: attitude)) {
                sawTransition = sawTransition || snapshot.status == .poseTransition
                last = snapshot
            }
        }
        #expect(sawTransition)
        #expect(last?.status == .axisEstimated)
        #expect(last?.directionResolved == false)
    }

    @Test func timestampRegressionGapAndSegmentChangeCreateNewFrames() {
        var estimator = WalkingFrameEstimator(configuration: testConfiguration())
        _ = estimator.process(input(timestamp: 1, acceleration: .zero))
        let first = estimator.frameId
        _ = estimator.process(input(timestamp: 0.9, acceleration: .zero))
        let afterRegression = estimator.frameId
        #expect(afterRegression != first)
        _ = estimator.process(input(timestamp: 2, acceleration: .zero))
        let afterGap = estimator.frameId
        #expect(afterGap != afterRegression)
        _ = estimator.process(input(timestamp: 2.02, acceleration: .zero, segment: "new-segment"))
        #expect(estimator.frameId != afterGap)
    }

    @Test func syntheticUTurnKeepsBothAxisSignsAndDoesNotForceForwardDirection() {
        var estimator = WalkingFrameEstimator(configuration: testConfiguration())
        var last: WalkingFrameSnapshot?
        for index in 0..<180 {
            let time = Double(index) * 0.02
            let sign = index < 90 ? 1.0 : -1.0
            let acceleration = Vector3D(x: sign * 0.2 * sin(2 * .pi * 1.8 * time), y: 0, z: 0)
            last = estimator.process(input(timestamp: time, acceleration: acceleration)) ?? last
        }
        #expect(last?.status == .axisEstimated)
        #expect(last?.directionResolved == false)
        #expect(last?.ambiguity == "AXIS_180")
    }
}

struct MotionSampleCompatibilityTests {
    @Test func legacyJSONDecodesWithNewOptionalFieldsAbsent() throws {
        let id = UUID(), session = UUID()
        let json = """
        {"id":"\(id.uuidString)","sessionId":"\(session.uuidString)","sequence":7,"timestamp":0,
        "userAccelerationX":0.1,"userAccelerationY":0.2,"userAccelerationZ":0.3,
        "rotationRateX":0,"rotationRateY":0,"rotationRateZ":0,
        "gravityX":0,"gravityY":0,"gravityZ":-1,
        "attitudeRoll":0,"attitudePitch":0,"attitudeYaw":0,
        "appState":"foreground","sensorSegmentId":"legacy"}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let sample = try decoder.decode(MotionSample.self, from: Data(json.utf8))
        #expect(sample.sequence == 7)
        #expect(sample.attitudeQuaternion == nil)
        #expect(sample.magneticField == nil)
        #expect(sample.walkingFrame == nil)
    }

    @Test func newFieldsRoundTripWithoutChangingSequence() throws {
        let sample = MotionSample(id: UUID(), sessionId: UUID(), sequence: 42, timestamp: Date(),
            userAccelerationX: 0.1, userAccelerationY: 0.2, userAccelerationZ: 0.3,
            rotationRateX: 0, rotationRateY: 0, rotationRateZ: 0,
            gravityX: 0, gravityY: 0, gravityZ: -1,
            attitudeRoll: 0, attitudePitch: 0, attitudeYaw: 0,
            attitudeQuaternion: .identity,
            magneticField: CalibratedMagneticFieldSample(x: 20, y: 30, z: 40, accuracy: .high),
            appState: .foreground, sensorSegmentId: "segment")
        let data = try JSONEncoder().encode(sample)
        let decoded = try JSONDecoder().decode(MotionSample.self, from: data)
        #expect(decoded.sequence == 42)
        #expect(decoded.attitudeQuaternion == .identity)
        #expect(decoded.magneticField?.accuracy == .high)
    }
}
