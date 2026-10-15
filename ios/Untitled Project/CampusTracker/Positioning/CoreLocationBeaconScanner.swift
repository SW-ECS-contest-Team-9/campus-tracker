import CoreLocation
import Foundation

/// Scanner state as the app shows it. Anything but `.ranging` means "no beacons now"; positioning goes on without them.
enum BeaconScannerState: Equatable, Sendable {
    case idle
    case ranging(uuids: Int)
    /// location permission missing (Core Location ranging needs When In Use or Always)
    case notAuthorized(String)
    /// approximate location: iOS returns no beacons without precise location
    case reducedAccuracy
    /// the device cannot range beacons
    case rangingUnavailable
    case noRegisteredBeacons
    case failed(String)
}

/// Platform scanner contract (shared by the collector and a future navigator).
@MainActor
protocol BeaconScanning: AnyObject {
    var state: BeaconScannerState { get }
    var onObservations: (([BeaconObservation]) -> Void)? { get set }
    var onStateChanged: ((BeaconScannerState) -> Void)? { get set }
    func start(proximityUUIDs: [UUID])
    func stop()
}

/// Core Location iBeacon scanner (iOS 13+ API: CLBeaconIdentityConstraint, CLBeacon.timestamp).
///
/// Roles are kept apart:
///  - Ranging (`startRangingBeacons(satisfying:)`) produces the RSSI observations. It runs while the app is active or
///    while background location updates keep it running during a collection; iOS gives no guarantee of continuous
///    background ranging, and gaps are expected.
///  - Monitoring (`CLBeaconRegion` enter/exit) only tracks region presence (diagnostics, and re-starting ranging after
///    the system paused it). It never produces positions. At most 20 regions per app.
///
/// Its own `CLLocationManager`: GPS collection (`LocationService`) keeps its settings and delegate untouched.
@MainActor
final class CoreLocationBeaconScanner: NSObject, BeaconScanning, CLLocationManagerDelegate {
    private let manager: CLLocationManager
    private var uuids: [UUID] = []
    private var constraints: [CLBeaconIdentityConstraint] = []
    private var regions: [CLBeaconRegion] = []
    private(set) var state: BeaconScannerState = .idle { didSet { if state != oldValue { onStateChanged?(state) } } }
    var onObservations: (([BeaconObservation]) -> Void)?
    var onStateChanged: ((BeaconScannerState) -> Void)?
    /// regions currently reported inside (monitoring)
    private(set) var insideRegions: Set<String> = []

    static let maxMonitoredRegions = 20

    init(manager: CLLocationManager = CLLocationManager()) {
        self.manager = manager
        super.init()
        manager.delegate = self
    }

    func start(proximityUUIDs: [UUID]) {
        stop()
        uuids = Array(Set(proximityUUIDs)).sorted { $0.uuidString < $1.uuidString }
        guard !uuids.isEmpty else { state = .noRegisteredBeacons; return }
        guard CLLocationManager.isRangingAvailable() else { state = .rangingUnavailable; return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: break
        case .notDetermined: state = .notAuthorized("notDetermined"); return // LocationService asks; we retry on the change
        case .denied: state = .notAuthorized("denied"); return
        case .restricted: state = .notAuthorized("restricted"); return
        @unknown default: state = .notAuthorized("unknown"); return
        }
        guard manager.accuracyAuthorization == .fullAccuracy else { state = .reducedAccuracy; return }
        constraints = uuids.map { CLBeaconIdentityConstraint(uuid: $0) }
        for constraint in constraints { manager.startRangingBeacons(satisfying: constraint) }
        if CLLocationManager.isMonitoringAvailable(for: CLBeaconRegion.self) {
            regions = uuids.prefix(Self.maxMonitoredRegions).map { CLBeaconRegion(uuid: $0, identifier: "campus.beacon.\($0.uuidString)") }
            for region in regions {
                region.notifyEntryStateOnDisplay = true
                manager.startMonitoring(for: region)
            }
        }
        state = .ranging(uuids: uuids.count)
        print("[BeaconScanner] ranging uuids=\(uuids.count) regions=\(regions.count)")
    }

    func stop() {
        for constraint in constraints { manager.stopRangingBeacons(satisfying: constraint) }
        for region in regions { manager.stopMonitoring(for: region) }
        constraints = []
        regions = []
        insideRegions = []
        if state != .idle { state = .idle }
    }

    // MARK: CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didRange beacons: [CLBeacon], satisfying constraint: CLBeaconIdentityConstraint) {
        // CLBeacon is a reference type owned by Core Location: copy into values right here.
        let observations = beacons.compactMap { beacon in
            BeaconObservationAdapter.observation(uuid: beacon.uuid, major: beacon.major.intValue, minor: beacon.minor.intValue,
                                                 rssi: beacon.rssi, accuracy: beacon.accuracy, proximity: beacon.proximity.label,
                                                 timestamp: beacon.timestamp)
        }
        if !observations.isEmpty { onObservations?(observations) }
    }

    func locationManager(_ manager: CLLocationManager, didFailRangingFor constraint: CLBeaconIdentityConstraint, error: Error) {
        print("[BeaconScanner] ranging failed uuid=\(constraint.uuid) error=\(error)")
        state = .failed((error as NSError).domain + ":\((error as NSError).code)")
    }

    func locationManager(_ manager: CLLocationManager, didDetermineState regionState: CLRegionState, for region: CLRegion) {
        if regionState == .inside { insideRegions.insert(region.identifier) } else { insideRegions.remove(region.identifier) }
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        // Monitoring is auxiliary: ranging continues without it.
        print("[BeaconScanner] monitoring failed region=\(region?.identifier ?? "—") error=\(error)")
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !uuids.isEmpty else { return }
        switch state {
        case .notAuthorized, .reducedAccuracy, .ranging: start(proximityUUIDs: uuids)
        default: break
        }
    }
}

extension CLProximity {
    var label: String {
        switch self {
        case .immediate: return "immediate"
        case .near: return "near"
        case .far: return "far"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }
}
