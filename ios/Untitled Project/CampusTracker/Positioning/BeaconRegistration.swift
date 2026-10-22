import Foundation

// Beacon registration form (pure). Same rules as the web page (frontend/src/beacon-scan.ts) and Android
// (BeaconRegistration.kt), checked against fixtures/beacon/registration-cases.json. Empty string = not entered;
// z may come from floorHeightM + mountAboveFloorM.

nonisolated struct BeaconRegistrationForm: Codable, Sendable, Equatable {
    var uuid = ""
    var major = ""
    var minor = ""
    var measuredPowerDbm = ""
    var label = ""
    var buildingId = ""
    var floor = ""
    var floorHeightM = ""
    var mountAboveFloorM = ""
    /// "wgs84" (latitude / longitude) or "grid" (EPSG:5186 x / y)
    var positionMode = "wgs84"
    var latitude = ""
    var longitude = ""
    var x = ""
    var y = ""
    var z = ""
    var horizontalAccuracyM = ""
}

/// `POST /api/v1/positioning/admin/beacons` body. Nil fields are left out of the JSON.
nonisolated struct BeaconCreateRequest: Codable, Sendable, Equatable {
    struct Position: Codable, Sendable, Equatable {
        var x: Double?
        var y: Double?
        var latitude: Double?
        var longitude: Double?
        var z: Double
    }
    struct Anchor: Codable, Sendable, Equatable {
        var buildingId: String
        var floor: String?
        var floorHeightM: Double?
        var position: Position?
        var horizontalAccuracyM: Double?
    }
    var uuid: String
    var major: Int
    var minor: Int
    var measuredPowerDbm: Int?
    var label: String?
    var anchor: Anchor?
}

/// A registered beacon as the admin API lists it (`GET /admin/beacons`). Placement is EPSG:5186 only.
nonisolated struct AdminBeacon: Codable, Sendable, Equatable, Identifiable {
    struct Anchor: Codable, Sendable, Equatable {
        struct Position: Codable, Sendable, Equatable { var x: Double; var y: Double; var z: Double }
        var anchorId: String
        var buildingId: String
        var floor: String?
        var floorHeightM: Double?
        var position: Position
        var horizontalAccuracyM: Double?
    }
    var beaconId: String
    var uuid: String
    var major: Int
    var minor: Int
    var measuredPowerDbm: Int?
    var enabled: Bool
    var label: String?
    var lastObservedAt: String?
    var anchor: Anchor?
    var id: String { beaconId }
    var key: String { beaconKey(uuid: uuid, major: major, minor: minor) }
}

/// `PATCH /api/v1/positioning/admin/beacons/:id` body. Cleared fields are sent as JSON null.
nonisolated enum BeaconPatch: Encodable, Sendable, Equatable {
    /// the edit form: identity is fixed; nil power / label clear them; no anchor unlinks the placement (anchorId null)
    case edit(measuredPowerDbm: Int?, label: String?, anchor: BeaconCreateRequest.Anchor?)
    /// disable (leaves the config and fusion, history kept) or enable again
    case enabled(Bool)

    private enum Key: String, CodingKey { case measuredPowerDbm, label, anchor, anchorId, enabled }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case let .edit(power, label, anchor):
            try c.encode(power, forKey: .measuredPowerDbm)
            try c.encode(label, forKey: .label)
            if let anchor { try c.encode(anchor, forKey: .anchor) } else { try c.encodeNil(forKey: .anchorId) }
        case let .enabled(on):
            try c.encode(on, forKey: .enabled)
        }
    }
}

nonisolated enum BeaconEditResult: Sendable, Equatable {
    case body(BeaconPatch)
    case errors([String: String])
}

nonisolated enum BeaconRegistrationResult: Sendable, Equatable {
    case body(BeaconCreateRequest)
    /// field name -> message (shown under the field)
    case errors([String: String])
}

nonisolated enum BeaconRegistration {
    /// "E2C56DB5DFFB48D2B060D0F5A71096E0", with dashes or braces -> lower-case 8-4-4-4-12, else nil.
    static func normalizeUUID(_ value: String) -> String? {
        let hex = value.lowercased().filter { !"{}- \t\n".contains($0) }
        guard hex.count == 32, hex.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
        let c = Array(hex)
        return [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { String(c[$0]) }.joined(separator: "-")
    }

    /// nil = empty; .nan = not a number (so it fails every range check)
    private static func number(_ value: String) -> Double? {
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return Double(t) ?? .nan
    }

    private static func isInteger(_ d: Double) -> Bool { d.isFinite && d == d.rounded() }

    /// 201100.0 -> "201100", 148.2 -> "148.2"
    private static func plain(_ d: Double) -> String {
        d == d.rounded() && abs(d) < 1e15 ? String(Int64(d)) : String(d)
    }

    /// The edit form of a registered beacon; the stored placement is EPSG:5186, so grid mode.
    static func form(from b: AdminBeacon) -> BeaconRegistrationForm {
        var f = BeaconRegistrationForm(uuid: b.uuid.uppercased(), major: String(b.major), minor: String(b.minor),
                                       measuredPowerDbm: b.measuredPowerDbm.map(String.init) ?? "", label: b.label ?? "")
        if let a = b.anchor {
            f.buildingId = a.buildingId
            f.floor = a.floor ?? ""
            f.floorHeightM = a.floorHeightM.map(plain) ?? ""
            f.positionMode = "grid"
            f.x = plain(a.position.x)
            f.y = plain(a.position.y)
            f.z = plain(a.position.z)
            f.horizontalAccuracyM = a.horizontalAccuracyM.map(plain) ?? ""
        }
        return f
    }

    /// The edit form -> PATCH body: same checks as a new beacon; identity is not sent (fixed).
    static func buildEdit(_ f: BeaconRegistrationForm) -> BeaconEditResult {
        switch build(f) {
        case let .errors(e): return .errors(e)
        case let .body(r): return .body(.edit(measuredPowerDbm: r.measuredPowerDbm, label: r.label, anchor: r.anchor))
        }
    }

    static func build(_ f: BeaconRegistrationForm) -> BeaconRegistrationResult {
        var errors: [String: String] = [:]
        let uuid = normalizeUUID(f.uuid)
        if uuid == nil { errors["uuid"] = "UUID는 16진수 32자리입니다" }
        func int16(_ key: String, _ v: String) -> Int? {
            guard let n = number(v), isInteger(n), n >= 0, n <= 65535 else { errors[key] = "0~65535 정수"; return nil }
            return Int(n)
        }
        let major = int16("major", f.major)
        let minor = int16("minor", f.minor)
        let power = number(f.measuredPowerDbm)
        if let p = power, !(isInteger(p) && p >= -127 && p <= 20) { errors["measuredPowerDbm"] = "−127~20 dBm 정수" }
        let blank = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        var anchor: BeaconCreateRequest.Anchor?
        if [f.buildingId, f.latitude, f.longitude, f.x, f.y].contains(where: { !blank($0) }) {
            if blank(f.buildingId) { errors["buildingId"] = "건물(바깥이면 outdoor)을 고르세요" }
            let floor = f.floor.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if !floor.isEmpty, floor.range(of: "^(B[1-9]|[1-9][0-9]?F)$", options: .regularExpression) == nil { errors["floor"] = "1F…99F 또는 B1…B9" }
            let floorHeight = number(f.floorHeightM)
            if let h = floorHeight, !h.isFinite { errors["floorHeightM"] = "숫자" }
            let mount = number(f.mountAboveFloorM)
            var z = number(f.z)
            if z == nil, let h = floorHeight, let m = mount, (h + m).isFinite { z = ((h + m) * 1000 + 0.5).rounded(.down) / 1000 }
            if z == nil || !(z!.isFinite) { errors["z"] = "설치 높이(해발 m) 또는 층 바닥 높이 + 바닥에서 높이를 넣으세요" }
            var position: BeaconCreateRequest.Position?
            if f.positionMode == "grid" {
                let x = number(f.x), y = number(f.y)
                if x == nil || !(100_000...700_000).contains(x!) { errors["x"] = "EPSG:5186 X(m)" }
                if y == nil || !(100_000...800_000).contains(y!) { errors["y"] = "EPSG:5186 Y(m)" }
                if let x, let y, let z { position = .init(x: x, y: y, z: z) }
            } else {
                let lat = number(f.latitude), lon = number(f.longitude)
                if lat == nil || !(33...39).contains(lat!) { errors["latitude"] = "위도 33~39" }
                if lon == nil || !(124...132).contains(lon!) { errors["longitude"] = "경도 124~132" }
                if let lat, let lon, let z { position = .init(latitude: lat, longitude: lon, z: z) }
            }
            let accuracy = number(f.horizontalAccuracyM)
            if let a = accuracy, !(a > 0 && a <= 100) { errors["horizontalAccuracyM"] = "0~100 m" }
            anchor = .init(buildingId: f.buildingId.trimmingCharacters(in: .whitespacesAndNewlines), floor: floor.isEmpty ? nil : floor,
                           floorHeightM: floorHeight, position: position, horizontalAccuracyM: accuracy)
        }
        guard errors.isEmpty, let uuid, let major, let minor else { return .errors(errors) }
        let label = f.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return .body(BeaconCreateRequest(uuid: uuid, major: major, minor: minor, measuredPowerDbm: power.map { Int($0) },
                                         label: label.isEmpty ? nil : label, anchor: anchor))
    }
}

/// One beacon heard by the registration scan. iOS ranging does not report the advertised 1 m power.
nonisolated struct HeardBeacon: Sendable, Equatable, Identifiable {
    let key: String
    let uuid: String
    let major: Int
    let minor: Int
    var count: Int
    var lastRssi: Int?
    var maxRssi: Int?
    var lastSeen: Date
    var registered: Bool
    var id: String { key }
}

/// Beacons heard during one registration scan: unregistered first, strongest first. RSSI outside −120…−1 is ignored.
nonisolated struct HeardBeacons: Sendable {
    private var byKey: [String: HeardBeacon] = [:]

    mutating func add(uuid: String, major: Int, minor: Int, rssi: Int?, at time: Date) {
        let key = beaconKey(uuid: uuid, major: major, minor: minor)
        let usable = rssi.flatMap { (-120 ... -1).contains($0) ? $0 : nil }
        if var row = byKey[key] {
            row.count += 1
            row.lastRssi = usable ?? row.lastRssi
            if let usable { row.maxRssi = max(row.maxRssi ?? -999, usable) }
            row.lastSeen = time
            byKey[key] = row
        } else {
            byKey[key] = HeardBeacon(key: key, uuid: uuid.lowercased(), major: major, minor: minor, count: 1, lastRssi: usable,
                                     maxRssi: usable, lastSeen: time, registered: false)
        }
    }

    /// The registered flag is evaluated now, so a beacon registered after it was heard shows as registered.
    func list(isRegistered: (String) -> Bool) -> [HeardBeacon] {
        byKey.values.map { row -> HeardBeacon in
            var r = row
            r.registered = isRegistered(row.key)
            return r
        }.sorted {
            if $0.registered != $1.registered { return !$0.registered }
            if ($0.maxRssi ?? -999) != ($1.maxRssi ?? -999) { return ($0.maxRssi ?? -999) > ($1.maxRssi ?? -999) }
            return $0.key < $1.key
        }
    }

    mutating func clear() { byKey = [:] }
}
