import Foundation
import Testing
@testable import CampusTracker

// Beacon registration (docs/BEACON_POSITIONING.md §5.4). fixtures/beacon/registration-cases.json is shared with the web
// page and Android.

private func registrationFixture() throws -> Data {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    return try Data(contentsOf: root.appendingPathComponent("fixtures/beacon/registration-cases.json"))
}

/// JSON equality with numbers compared numerically (1 == 1.0).
private func sameJSON(_ a: Any, _ b: Any) -> Bool {
    if let a = a as? [String: Any], let b = b as? [String: Any] {
        return Set(a.keys) == Set(b.keys) && a.keys.allSatisfy { sameJSON(a[$0]!, b[$0]!) }
    }
    if a is NSNull || b is NSNull { return a is NSNull && b is NSNull }
    if let a = a as? String, let b = b as? String { return a == b }
    if let a = a as? NSNumber, let b = b as? NSNumber { return a.doubleValue == b.doubleValue }
    return false
}

private let testUUID = "e2c56db5-dffb-48d2-b060-d0f5a71096e0"

struct BeaconRegistrationFormTests {
    private struct Case: Decodable { let name: String; let form: BeaconRegistrationForm; let errors: [String]? }
    private struct Cases: Decodable { let cases: [Case] }

    @Test func sharedRegistrationCases() throws {
        let data = try registrationFixture()
        let cases = try JSONDecoder().decode(Cases.self, from: data).cases
        let raw = try #require((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["cases"] as? [[String: Any]])
        #expect(cases.count >= 7)
        for (c, r) in zip(cases, raw) {
            switch BeaconRegistration.build(c.form) {
            case let .body(body):
                let expected = try #require(r["body"], "\(c.name): expected errors")
                let got = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body))
                #expect(sameJSON(got, expected), "\(c.name)")
            case let .errors(fields):
                #expect(fields.keys.sorted() == c.errors, "\(c.name)")
            }
        }
    }

    private struct EditCases: Decodable {
        struct ToForm: Decodable { let name: String; let beacon: AdminBeacon; let form: BeaconRegistrationForm }
        let editCases: [Case]
        let beaconToForm: [ToForm]
    }

    @Test func sharedEditCases() throws {
        let data = try registrationFixture()
        let fx = try JSONDecoder().decode(EditCases.self, from: data)
        let raw = try #require((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["editCases"] as? [[String: Any]])
        #expect(fx.editCases.count >= 3)
        for (c, r) in zip(fx.editCases, raw) {
            switch BeaconRegistration.buildEdit(c.form) {
            case let .body(patch):
                let expected = try #require(r["body"], "\(c.name): expected errors")
                let got = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch))
                #expect(sameJSON(got, expected), "\(c.name)")
            case let .errors(fields):
                #expect(fields.keys.sorted() == c.errors, "\(c.name)")
            }
        }
        for c in fx.beaconToForm {
            #expect(BeaconRegistration.form(from: c.beacon) == c.form, "\(c.name)")
            if case .errors = BeaconRegistration.buildEdit(c.form) { Issue.record("\(c.name): opened form does not save") }
        }
        let enable = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BeaconPatch.enabled(false)))
        #expect(sameJSON(enable, ["enabled": false]))
    }

    @Test func uuidNormalization() {
        #expect(BeaconRegistration.normalizeUUID(" E2C56DB5-DFFB-48D2-B060-D0F5A71096E0 ") == testUUID)
        #expect(BeaconRegistration.normalizeUUID("xyz") == nil)
    }

    @Test func heardListOrdersAndReevaluatesRegistration() {
        var heard = HeardBeacons()
        let t = Date(timeIntervalSince1970: 1000)
        heard.add(uuid: testUUID.uppercased(), major: 1, minor: 1, rssi: -50, at: t)
        heard.add(uuid: testUUID, major: 1, minor: 2, rssi: -80, at: t)
        heard.add(uuid: testUUID, major: 1, minor: 3, rssi: -70, at: t)
        heard.add(uuid: testUUID, major: 1, minor: 2, rssi: 0, at: t) // CLBeacon reports 0 when unknown: counted, ignored
        let rows = heard.list { $0.hasSuffix(":1:1") }
        #expect(rows.map(\.minor) == [3, 2, 1])
        #expect(rows[1].count == 2 && rows[1].maxRssi == -80)
        #expect(rows[2].registered && rows[2].uuid == testUUID)
        #expect(heard.list { _ in false }.allSatisfy { !$0.registered })
    }
}

@MainActor
private final class FakeRegistrationScanner: BeaconScanning {
    var state: BeaconScannerState = .idle
    var onObservations: (([BeaconObservation]) -> Void)?
    var onStateChanged: ((BeaconScannerState) -> Void)?
    var started: [UUID] = []
    func start(proximityUUIDs: [UUID]) { started = proximityUUIDs; state = .ranging(uuids: proximityUUIDs.count); onStateChanged?(state) }
    func stop() { state = .idle; onStateChanged?(state) }
}

@MainActor
private final class FakeRegistrationBackend: BeaconRegistrationBackend {
    var accessError: Error?
    var registerError: Error?
    var registered = [AdminBeacon(beaconId: "b0", uuid: testUUID, major: 1, minor: 1, enabled: true)]
    var posted: [BeaconCreateRequest] = []
    var patches: [(String, BeaconPatch)] = []
    func checkAccess() async throws { if let accessError { throw accessError } }
    func beacons() async throws -> [AdminBeacon] { registered }
    func surveyUUIDs() async throws -> [String] { ["11111111-2222-3333-4444-555555555555"] }
    func register(_ request: BeaconCreateRequest) async throws -> String {
        if let registerError { throw registerError }
        posted.append(request)
        registered.append(AdminBeacon(beaconId: "b\(registered.count)", uuid: request.uuid, major: request.major, minor: request.minor, enabled: true))
        return "ok"
    }
    func update(_ beaconId: String, _ patch: BeaconPatch) async throws -> AdminBeacon {
        patches.append((beaconId, patch))
        guard let i = registered.firstIndex(where: { $0.beaconId == beaconId }) else {
            throw BeaconAdminError(status: 404, code: "BEACON_NOT_FOUND", message: nil)
        }
        switch patch {
        case let .enabled(on): registered[i].enabled = on
        case let .edit(power, label, anchor):
            registered[i].measuredPowerDbm = power
            registered[i].label = label
            registered[i].anchor = anchor.flatMap { a in
                a.position.flatMap { p in p.x.map { x in
                    AdminBeacon.Anchor(anchorId: "a\(i)", buildingId: a.buildingId, floor: a.floor, floorHeightM: a.floorHeightM,
                                       position: .init(x: x, y: p.y ?? 0, z: p.z), horizontalAccuracyM: a.horizontalAccuracyM)
                } }
            }
        }
        return registered[i]
    }
    func delete(_ beaconId: String) async throws {
        guard registered.contains(where: { $0.beaconId == beaconId }) else { throw BeaconAdminError(status: 404, code: "BEACON_NOT_FOUND", message: nil) }
        registered.removeAll { $0.beaconId == beaconId }
    }
    func buildings() async throws -> [AnchorBuilding] { [AnchorBuilding(buildingId: "B07", buildingName: "Library")] }
}

@MainActor
struct BeaconRegistrationModelTests {
    private func observation(minor: Int, rssi: Int) -> BeaconObservation {
        BeaconObservationAdapter.observation(uuid: UUID(uuidString: testUUID)!, major: 1, minor: minor, rssi: rssi, accuracy: 1,
                                             proximity: "near", timestamp: Date())!
    }

    @Test func accessIsChecked() async {
        let backend = FakeRegistrationBackend()
        backend.accessError = BeaconAdminError(status: 403, code: "POSITIONING_ADMIN_REQUIRED", message: nil)
        let denied = BeaconRegistrationModel(backend: backend, scanner: FakeRegistrationScanner())
        await denied.open()
        #expect(denied.access == .denied)
        backend.accessError = BeaconAdminError(status: 401, code: "UNAUTHORIZED", message: nil)
        await denied.open()
        #expect(denied.access == .signedOut)
    }

    @Test func searchPickLocateSubmit() async {
        let backend = FakeRegistrationBackend()
        let scanner = FakeRegistrationScanner()
        var refreshed = 0
        let model = BeaconRegistrationModel(backend: backend, scanner: scanner,
                                            latestFix: { BeaconGeoFix(latitude: 37.6105, longitude: 126.9971, accuracy: 4) },
                                            onRegistered: { refreshed += 1 })
        await model.open()
        #expect(model.access == .allowed)
        #expect(model.buildings.map(\.buildingId) == ["B07"])
        // registered + survey UUIDs, plus a typed one
        model.extraUUID = "{AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE}"
        model.startScan()
        #expect(scanner.started.count == 3)
        #expect(model.scanning)

        model.record([observation(minor: 1, rssi: -40), observation(minor: 7, rssi: -55)])
        #expect(model.heard.map(\.minor) == [7, 1]) // unregistered first
        model.pick(model.heard[0])
        #expect(model.form.uuid == testUUID.uppercased() && model.form.minor == "7")
        await model.useCurrentLocation()
        #expect(model.form.latitude == "37.6105000")
        #expect(model.form.horizontalAccuracyM == "4")

        await model.submit() // a position without building / height: field errors, nothing posted
        #expect(Set(model.errors.keys).isSuperset(of: ["buildingId", "z"]))
        #expect(backend.posted.isEmpty)

        model.form.buildingId = "B07"
        model.form.floor = "3F"
        model.form.floorHeightM = "148.2"
        model.form.mountAboveFloorM = "2.5"
        await model.submit()
        #expect(model.errors.isEmpty)
        #expect(backend.posted.first?.minor == 7)
        #expect(backend.posted.first?.anchor?.position?.z == 150.7)
        #expect(refreshed == 1)
        #expect(model.heard.allSatisfy { $0.registered })

        model.close()
        #expect(!model.scanning)
        #expect(scanner.state == .idle)
    }

    @Test func badTypedUUIDAndDuplicateAreExplained() async {
        let backend = FakeRegistrationBackend()
        let scanner = FakeRegistrationScanner()
        let model = BeaconRegistrationModel(backend: backend, scanner: scanner)
        await model.open()
        model.extraUUID = "nope"
        model.startScan()
        #expect(!model.scanning && scanner.started.isEmpty)
        backend.registerError = BeaconAdminError(status: 409, code: "BEACON_EXISTS", message: "exists")
        model.form = BeaconRegistrationForm(uuid: testUUID, major: "1", minor: "2")
        await model.submit()
        #expect(model.message?.contains("이미 등록") == true)
    }

    @Test func editDisableDelete() async {
        let backend = FakeRegistrationBackend()
        backend.registered.append(AdminBeacon(beaconId: "b1", uuid: testUUID, major: 1, minor: 2, enabled: true))
        var refreshed = 0
        let model = BeaconRegistrationModel(backend: backend, scanner: FakeRegistrationScanner(), onRegistered: { refreshed += 1 })
        await model.open()
        #expect(model.registered.count == 2)
        let target = model.registered[1]
        model.startEdit(target)
        #expect(model.editing == target && model.form.minor == "2")

        model.form.label = "hall door"
        model.form.buildingId = "B07"
        model.form.positionMode = "grid"
        model.form.x = "201100"
        model.form.y = "557250"
        model.form.z = "154.5"
        await model.submit()
        #expect(backend.patches.last?.0 == "b1")
        #expect(model.editing?.label == "hall door")
        #expect(model.form.x == "201100" && model.form.positionMode == "grid")
        #expect(model.registered[1].label == "hall door")
        #expect(refreshed == 1)

        model.form.floor = "5G" // invalid: field errors, nothing sent
        await model.submit()
        #expect(model.errors["floor"] != nil && backend.patches.count == 1)
        model.form.floor = ""

        await model.setEnabled(false)
        #expect(model.editing?.enabled == false && backend.patches.last?.1 == .enabled(false))

        await model.delete()
        #expect(model.editing == nil && model.form == BeaconRegistrationForm())
        #expect(model.registered.map(\.minor) == [1])
        #expect(model.message?.hasPrefix("삭제했습니다") == true)
        #expect(refreshed == 3)
    }

    @Test func heardRegisteredBeaconOpensForEditingAndPickLeavesIt() async {
        let backend = FakeRegistrationBackend()
        let model = BeaconRegistrationModel(backend: backend, scanner: FakeRegistrationScanner())
        await model.open()
        model.record([observation(minor: 1, rssi: -50), observation(minor: 5, rssi: -60)])
        model.edit(heard: model.heard.first { $0.minor == 1 }!)
        #expect(model.editing?.beaconId == "b0")
        model.pick(model.heard.first { $0.minor == 5 }!)
        #expect(model.editing == nil && model.form.minor == "5")
        // a beacon deleted elsewhere: saving reports it and returns to a new registration
        model.startEdit(model.registered[0])
        backend.registered.removeAll()
        await model.submit()
        #expect(model.message == "이미 삭제된 비콘입니다.")
        #expect(model.editing == nil && model.registered.isEmpty)
    }
}
