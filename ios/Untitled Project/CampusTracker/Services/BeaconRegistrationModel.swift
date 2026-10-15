import Combine
import CoreLocation
import Foundation

/// Error body of the server (`{ "error": { "code", "message" } }`) on a non-2xx admin call.
struct BeaconAdminError: Error, Equatable {
    let status: Int
    let code: String?
    let message: String?
}

struct RegisteredBeaconIdentity: Codable, Equatable {
    let uuid: String
    let major: Int
    let minor: Int
}

/// Server side of registration: `/api/v1/positioning/admin/*` with this collector's token (POSITIONING_ADMIN_COLLECTORS).
protocol BeaconRegistrationBackend: AnyObject {
    /// succeeds when this account may register; throws BeaconAdminError 403 / 401 otherwise
    func checkAccess() async throws
    /// every registered beacon, enabled or not
    func registeredBeacons() async throws -> [RegisteredBeaconIdentity]
    /// UUIDs added on the web page for surveying beacons not registered yet
    func surveyUUIDs() async throws -> [String]
    /// returns a short description of the created beacon
    func register(_ request: BeaconCreateRequest) async throws -> String
    func buildings() async throws -> [AnchorBuilding]
}

/// URLSession implementation. The server address and token are read at each call (sign-in can change while the screen is open).
final class HTTPBeaconRegistrationBackend: BeaconRegistrationBackend {
    private let configuration: () -> ServerConfiguration?
    private let token: () -> String?

    init(configuration: @escaping () -> ServerConfiguration?, token: @escaping () -> String?) {
        self.configuration = configuration
        self.token = token
    }

    private struct ErrorEnvelope: Decodable {
        struct Body: Decodable { let code: String?; let message: String? }
        let error: Body?
    }

    private func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        guard let base = configuration()?.baseURL else { throw URLError(.badURL) }
        guard let token = token() else { throw BeaconAdminError(status: 401, code: "TOKEN_REQUIRED", message: nil) }
        guard let url = URL(string: "api/v1/positioning/admin" + path, relativeTo: base) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw BeaconAdminError(status: http.statusCode, code: envelope?.error?.code, message: envelope?.error?.message)
        }
        return data
    }

    func checkAccess() async throws { _ = try await call("GET", "/me") }

    func registeredBeacons() async throws -> [RegisteredBeaconIdentity] {
        struct Response: Decodable { let beacons: [RegisteredBeaconIdentity] }
        return try JSONDecoder().decode(Response.self, from: try await call("GET", "/beacons?includeDisabled=true")).beacons
    }

    func surveyUUIDs() async throws -> [String] {
        struct Row: Decodable { let uuid: String }
        struct Response: Decodable { let surveyUuids: [Row] }
        return try JSONDecoder().decode(Response.self, from: try await call("GET", "/survey-uuids")).surveyUuids.map(\.uuid)
    }

    func register(_ request: BeaconCreateRequest) async throws -> String {
        struct Created: Decodable { let uuid: String; let major: Int; let minor: Int; let label: String? }
        let data = try await call("POST", "/beacons", body: try JSONEncoder().encode(request))
        let b = try JSONDecoder().decode(Created.self, from: data)
        return [b.label, "\(b.uuid) / \(b.major) / \(b.minor)"].compactMap { $0 }.joined(separator: " · ")
    }

    func buildings() async throws -> [AnchorBuilding] {
        guard let configuration = configuration() else { return [] }
        return try await AnchorNodeAPI.fetch(configuration: configuration, buildingId: nil, floor: nil, latitude: nil, longitude: nil).buildings
    }
}

struct BeaconGeoFix: Equatable {
    let latitude: Double
    let longitude: Double
    let accuracy: Double?
}

/// Registration screen logic (admin tooling inside the collector app, docs/BEACON_POSITIONING.md §5.4).
///
/// iOS can only range beacons whose proximity UUID it already knows (Core Location has no "every iBeacon" scan), so the
/// search covers: the UUIDs of registered beacons, the survey UUIDs added on the web page, and a UUID typed on this
/// screen. Beacons with any other UUID are entered by hand (or found with Android / the web page). Independent of
/// collection: its own scanner and location manager, nothing it does touches the active session.
final class BeaconRegistrationModel: NSObject, ObservableObject, CLLocationManagerDelegate {
    enum Access: Equatable { case checking, allowed, denied, signedOut, unreachable }

    @Published private(set) var access: Access = .checking
    @Published private(set) var scanning = false
    @Published private(set) var scannerState: BeaconScannerState = .idle
    @Published private(set) var heard: [HeardBeacon] = []
    @Published var form = BeaconRegistrationForm()
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var message: String?
    @Published private(set) var submitting = false
    @Published private(set) var buildings: [AnchorBuilding] = []
    /// UUIDs the search ranges (registered + survey + typed)
    @Published private(set) var searchUUIDs: [String] = []
    /// a UUID typed on this screen to add to the search
    @Published var extraUUID = ""

    private let backend: BeaconRegistrationBackend
    private let scanner: BeaconScanning
    private let latestFix: () -> BeaconGeoFix?
    private let onRegistered: () -> Void
    private let now: () -> Date
    private var registeredKeys: Set<String> = []
    private var known: [String] = []
    private var heardRows = HeardBeacons()
    private var locationManager: CLLocationManager?
    private var locationWaiters: [CheckedContinuation<BeaconGeoFix?, Never>] = []
    private var locationRequest = 0

    init(backend: BeaconRegistrationBackend, scanner: BeaconScanning? = nil, latestFix: @escaping () -> BeaconGeoFix? = { nil },
         now: @escaping () -> Date = Date.init, onRegistered: @escaping () -> Void = {}) {
        self.backend = backend
        self.scanner = scanner ?? CoreLocationBeaconScanner()
        self.latestFix = latestFix
        self.now = now
        self.onRegistered = onRegistered
        super.init()
        self.scanner.onStateChanged = { [weak self] in self?.scannerState = $0 }
        self.scanner.onObservations = { [weak self] in self?.record($0) }
    }

    /// Screen opened: who may register, what is registered, which UUIDs to search, the building list.
    func open() async {
        access = .checking
        message = nil
        do {
            try await backend.checkAccess()
            access = .allowed
        } catch let e as BeaconAdminError {
            access = e.status == 401 ? .signedOut : (e.status == 403 || e.code == "POSITIONING_ADMIN_REQUIRED") ? .denied : .unreachable
        } catch {
            access = .unreachable
        }
        guard access == .allowed else { return }
        var uuids: [String] = []
        if let beacons = try? await backend.registeredBeacons() {
            registeredKeys = Set(beacons.map { beaconKey(uuid: $0.uuid, major: $0.major, minor: $0.minor) })
            uuids += beacons.map(\.uuid)
        }
        uuids += (try? await backend.surveyUUIDs()) ?? []
        known = uuids
        updateSearchUUIDs()
        buildings = (try? await backend.buildings()) ?? []
        heard = heardRows.list { registeredKeys.contains($0) }
    }

    private func updateSearchUUIDs() {
        let typed = BeaconRegistration.normalizeUUID(extraUUID).map { [$0] } ?? []
        searchUUIDs = Array(Set((known + typed).compactMap(BeaconRegistration.normalizeUUID))).sorted()
    }

    func startScan() {
        updateSearchUUIDs()
        if !extraUUID.trimmingCharacters(in: .whitespaces).isEmpty, BeaconRegistration.normalizeUUID(extraUUID) == nil {
            message = "추가 UUID는 16진수 32자리입니다."
            return
        }
        guard !searchUUIDs.isEmpty else {
            message = "검색할 UUID가 없습니다. 비콘의 UUID를 입력하거나 웹 등록 페이지에서 조사 UUID를 추가하세요."
            return
        }
        heardRows.clear()
        heard = []
        message = nil
        scanning = true
        // ranging needs When In Use; the scanner retries by itself once the answer comes
        if scanner is CoreLocationBeaconScanner {
            let manager = locationManager ?? CLLocationManager()
            locationManager = manager
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        }
        scanner.start(proximityUUIDs: searchUUIDs.compactMap(UUID.init(uuidString:)))
    }

    func stopScan() {
        scanner.stop()
        scanning = false
    }

    func record(_ observations: [BeaconObservation]) {
        for o in observations { heardRows.add(uuid: o.uuid, major: o.major, minor: o.minor, rssi: o.rssiDbm, at: o.observedAt) }
        heard = heardRows.list { registeredKeys.contains($0) }
    }

    /// Tap on a heard beacon: identifier into the form (iOS does not report the advertised 1 m power; the rest is kept).
    func pick(_ b: HeardBeacon) {
        form.uuid = b.uuid.uppercased()
        form.major = String(b.major)
        form.minor = String(b.minor)
        errors = [:]
        message = nil
    }

    func useCurrentLocation() async {
        message = "현재 위치를 읽는 중…"
        let fix: BeaconGeoFix?
        if let latest = latestFix() { fix = latest } else { fix = await requestLocation() }
        guard let fix else {
            message = "위치를 읽지 못했습니다. 위치 권한·위치 서비스를 확인하세요."
            return
        }
        form.positionMode = "wgs84"
        form.latitude = String(format: "%.7f", fix.latitude)
        form.longitude = String(format: "%.7f", fix.longitude)
        if let a = fix.accuracy, a > 0 { form.horizontalAccuracyM = String(Int(min(max(a, 1), 100))) }
        message = "현재 위치 ±\(fix.accuracy.map { String(Int($0)) } ?? "?") m (실내 GPS는 수십 m 틀릴 수 있습니다)"
    }

    func submit() async {
        switch BeaconRegistration.build(form) {
        case let .errors(fields):
            errors = fields
            message = "입력을 확인하세요."
        case let .body(request):
            errors = [:]
            submitting = true
            message = nil
            do {
                let created = try await backend.register(request)
                registeredKeys.insert(beaconKey(uuid: request.uuid, major: request.major, minor: request.minor))
                if !known.contains(request.uuid) { known.append(request.uuid) }
                onRegistered()
                message = "등록했습니다: \(created)"
            } catch let e as BeaconAdminError {
                switch e.code {
                case "BEACON_EXISTS": message = "이미 등록된 UUID·Major·Minor입니다."
                case "POSITIONING_ADMIN_REQUIRED": message = "이 계정은 비콘 등록 권한이 없습니다."
                case "VALIDATION_ERROR": message = "서버가 입력을 거절했습니다: \(e.message ?? "")"
                default: message = e.message ?? "HTTP \(e.status)"
                }
            } catch {
                message = "서버에 연결하지 못했습니다: \(error.localizedDescription)"
            }
            submitting = false
            heard = heardRows.list { registeredKeys.contains($0) }
        }
    }

    func clearForm() {
        form = BeaconRegistrationForm()
        errors = [:]
        message = nil
    }

    func close() {
        stopScan()
        locationManager?.stopUpdatingLocation()
        finishLocation(nil)
    }

    // MARK: one-shot location (its own manager: LocationService keeps its settings and delegate)

    private func requestLocation() async -> BeaconGeoFix? {
        await withCheckedContinuation { continuation in
            locationWaiters.append(continuation)
            let manager = locationManager ?? CLLocationManager()
            locationManager = manager
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyBest
            switch manager.authorizationStatus {
            case .notDetermined: manager.requestWhenInUseAuthorization() // the request follows on the authorization change
            case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
            default: finishLocation(nil)
            }
            locationRequest += 1
            let request = locationRequest
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if let self, self.locationRequest == request { self.finishLocation(nil) } // no answer: give up
            }
        }
    }

    private func finishLocation(_ fix: BeaconGeoFix?) {
        let waiters = locationWaiters
        locationWaiters = []
        waiters.forEach { $0.resume(returning: fix) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !locationWaiters.isEmpty else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        case .notDetermined: break
        default: finishLocation(nil)
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        finishLocation(BeaconGeoFix(latitude: l.coordinate.latitude, longitude: l.coordinate.longitude,
                                    accuracy: l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : nil))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finishLocation(nil)
    }
}
