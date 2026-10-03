import CoreLocation
import CoreMotion
import Foundation
import UIKit

extension CLAuthorizationStatus {
    var diagnosticLabel: String {
        switch self {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorizedAlways"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        @unknown default: return "unknown"
        }
    }
}

extension CLAccuracyAuthorization {
    var diagnosticLabel: String {
        switch self {
        case .fullAccuracy: return "fullAccuracy"
        case .reducedAccuracy: return "reducedAccuracy"
        @unknown default: return "unknown"
        }
    }
}

final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private(set) var lastLocation: CLLocation?
    private(set) var isActive = false
    var onLocation: ((CLLocation) -> Void)?
    var onAuthorizationChanged: ((CLAuthorizationStatus) -> Void)?
    var onPaused: (() -> Void)?
    var onResumed: (() -> Void)?
    var authorizationStatus: CLAuthorizationStatus { manager.authorizationStatus }
    var accuracyAuthorization: CLAccuracyAuthorization { manager.accuracyAuthorization }

    override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .fitness
        manager.pausesLocationUpdatesAutomatically = true
    }

    func start(profile: LocationCollectionProfile, distanceFilter: CLLocationDistance) {
        manager.activityType = .fitness
        manager.desiredAccuracy = profile.desiredAccuracy
        manager.distanceFilter = distanceFilter
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        switch manager.authorizationStatus {
        case .notDetermined:
            isActive = false
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            isActive = true
            manager.startUpdatingLocation()
        case .denied, .restricted:
            isActive = false
            onAuthorizationChanged?(manager.authorizationStatus)
        @unknown default:
            break
        }
    }

    func requestAlwaysAuthorization() {
        guard manager.authorizationStatus == .authorizedWhenInUse else { return }
        manager.requestAlwaysAuthorization()
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        manager.showsBackgroundLocationIndicator = false
        isActive = false
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        onAuthorizationChanged?(status)
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            isActive = true
            manager.startUpdatingLocation()
        } else {
            isActive = false
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            lastLocation = location
            onLocation?(location)
        }
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        onPaused?()
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        onResumed?()
    }
}

final class MotionService {
    private let manager = CMMotionManager()
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "CampusCollector.motion"
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .utility
        return queue
    }()
    var onMotion: ((CMDeviceMotion) -> Void)?
    private(set) var activeReferenceFrame: CMAttitudeReferenceFrame?

    var isAvailable: Bool { manager.isDeviceMotionAvailable }
    var isActive: Bool { manager.isDeviceMotionActive }

    /// Chooses the most absolute reference frame the device supports. The default frame used by
    /// `startDeviceMotionUpdates(to:)` (no frame argument) is `.xArbitraryZVertical`, which has no
    /// magnetometer correction at all and yields a yaw origin with no real-world meaning.
    static func preferredAttitudeReferenceFrame() -> CMAttitudeReferenceFrame {
        let available = CMMotionManager.availableAttitudeReferenceFrames()
        if available.contains(.xTrueNorthZVertical) { return .xTrueNorthZVertical }
        if available.contains(.xMagneticNorthZVertical) { return .xMagneticNorthZVertical }
        return .xArbitraryCorrectedZVertical
    }

    static func label(for frame: CMAttitudeReferenceFrame) -> String {
        switch frame {
        case .xTrueNorthZVertical: return "xTrueNorthZVertical"
        case .xMagneticNorthZVertical: return "xMagneticNorthZVertical"
        case .xArbitraryCorrectedZVertical: return "xArbitraryCorrectedZVertical"
        case .xArbitraryZVertical: return "xArbitraryZVertical"
        default: return "unknown"
        }
    }

    func start(rate: MotionSamplingRate, using frame: CMAttitudeReferenceFrame) {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = rate.interval
        activeReferenceFrame = frame
        manager.startDeviceMotionUpdates(using: frame, to: queue) { [weak self] motion, _ in
            guard let motion = motion else { return }
            self?.onMotion?(motion)
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        activeReferenceFrame = nil
    }
}

final class AltimeterService {
    private let altimeter = CMAltimeter()
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "CampusCollector.altimeter"
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .utility
        return queue
    }()
    var onAltitude: ((CMAltitudeData) -> Void)?
    private(set) var isActive = false

    func start() {
        guard CMAltimeter.isRelativeAltitudeAvailable() else { return }
        isActive = true
        altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] data, _ in
            guard let data = data else { return }
            self?.onAltitude?(data)
        }
    }

    func stop() {
        altimeter.stopRelativeAltitudeUpdates()
        isActive = false
    }
}

final class PedometerService {
    private let pedometer = CMPedometer()
    var onPedometer: ((CMPedometerData) -> Void)?
    var onError: ((Error?) -> Void)?
    private(set) var isActive = false

    /// Must be started with `from: sessionStartDate` (not `Date()`), since the server treats
    /// every sample in a pedometer run as a *cumulative* count since that baseline. Starting
    /// from "now" on a restart silently resets the running total the server already has.
    func start(capabilities: SensorCapabilities, from sessionStartDate: Date) {
        guard capabilities.pedometerAvailable else { return }
        isActive = true
        pedometer.startUpdates(from: sessionStartDate) { [weak self] data, error in
            guard let data, error == nil else {
                self?.onError?(error)
                return
            }
            self?.onPedometer?(data)
        }
    }

    /// Recovers a gap by re-querying the *entire* session-to-date window, so the single
    /// recovered sample is a cumulative value consistent with the live stream, not an
    /// incremental delta since the last sample.
    func recover(from start: Date, to end: Date = Date(), completion: @escaping (CMPedometerData?) -> Void) {
        guard start < end else {
            completion(nil)
            return
        }
        pedometer.queryPedometerData(from: start, to: end) { data, error in
            if let error {
                print("[Pedometer] historical recovery failed error=\(error.localizedDescription)")
            }
            completion(data)
        }
    }

    func stop() {
        pedometer.stopUpdates()
        isActive = false
    }
}

enum SensorCapabilityDetector {
    static func detect(
        attitudeReferenceFrame: String? = nil,
        motionUpdateHz: Int? = nil,
        locationAuthorization: String? = nil,
        locationAccuracyAuthorization: String? = nil,
        backgroundLocationUpdates: Bool? = nil,
        pausesLocationUpdatesAutomatically: Bool? = nil
    ) -> SensorCapabilities {
        SensorCapabilities(
            locationAvailable: CLLocationManager.locationServicesEnabled(),
            deviceMotionAvailable: CMMotionManager().isDeviceMotionAvailable,
            altimeterAvailable: CMAltimeter.isRelativeAltitudeAvailable(),
            stepCountingAvailable: CMPedometer.isStepCountingAvailable(),
            distanceAvailable: CMPedometer.isDistanceAvailable(),
            floorCountingAvailable: CMPedometer.isFloorCountingAvailable(),
            paceAvailable: CMPedometer.isPaceAvailable(),
            cadenceAvailable: CMPedometer.isCadenceAvailable(),
            attitudeReferenceFrame: attitudeReferenceFrame,
            motionUpdateHz: motionUpdateHz,
            locationAuthorization: locationAuthorization,
            locationAccuracyAuthorization: locationAccuracyAuthorization,
            backgroundLocationUpdates: backgroundLocationUpdates,
            pausesLocationUpdatesAutomatically: pausesLocationUpdatesAutomatically
        )
    }
}

enum DeviceInfoProvider {
    private static let deviceIdKey = "CampusCollector.deviceId"

    static func current(capabilities: SensorCapabilities) -> DeviceInfo {
        let defaults = UserDefaults.standard
        let deviceId: UUID
        if let stored = defaults.string(forKey: deviceIdKey), let value = UUID(uuidString: stored) {
            deviceId = value
        } else {
            let value = UUID()
            defaults.set(value.uuidString, forKey: deviceIdKey)
            deviceId = value
        }
        let device = UIDevice.current
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
        return DeviceInfo(
            deviceId: deviceId,
            deviceModel: device.model,
            systemName: device.systemName,
            systemVersion: device.systemVersion,
            appVersion: version,
            sensorCapabilities: capabilities
        )
    }
}
