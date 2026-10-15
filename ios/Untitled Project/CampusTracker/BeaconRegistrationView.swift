import SwiftUI
import UIKit

/// Beacon registration (docs/BEACON_POSITIONING.md §5.4): nearby beacon search, manual entry, current location.
struct BeaconRegistrationView: View {
    @StateObject private var model: BeaconRegistrationModel

    init(authentication: AuthenticationManager, coordinator: CollectionCoordinator) {
        _model = StateObject(wrappedValue: BeaconRegistrationModel(
            backend: HTTPBeaconRegistrationBackend(configuration: { [weak authentication] in authentication?.configuration },
                                                   token: { [weak authentication] in authentication?.currentAccessToken() }),
            latestFix: { [weak coordinator] in
                // a fix of the running collection (less than 30 s old) is as good as a new one
                guard let l = coordinator?.latestLocation, Date().timeIntervalSince(l.timestamp) < 30 else { return nil }
                return BeaconGeoFix(latitude: l.latitude, longitude: l.longitude, accuracy: l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : nil)
            },
            onRegistered: { [weak coordinator] in coordinator?.beaconRecorder.registryChanged() }))
    }

    var body: some View {
        Form {
            switch model.access {
            case .checking:
                Section { ProgressView("권한 확인 중…") }
            case .allowed:
                searchSection
                identitySection
                placementSection
                submitSection
            case .denied, .signedOut, .unreachable:
                Section {
                    Text(accessMessage).foregroundColor(.red)
                    Button("다시 확인") { Task { await model.open() } }
                }
            }
        }
        .navigationTitle("비콘 등록")
        .task { await model.open() }
        .onDisappear { model.close() }
    }

    private var accessMessage: String {
        switch model.access {
        case .denied: return "이 계정은 비콘 등록 권한이 없습니다. 서버 .env의 POSITIONING_ADMIN_COLLECTORS에 계정 코드를 추가하세요."
        case .signedOut: return "로그인이 필요합니다."
        default: return "서버에 연결하지 못했습니다."
        }
    }

    private var searchSection: some View {
        Section(header: Text("주변 비콘 검색"),
                footer: Text("iOS는 UUID를 아는 비콘만 찾을 수 있습니다. 등록된 비콘·웹에서 추가한 조사 UUID(\(model.searchUUIDs.count)개)와 아래에 입력한 UUID로 검색합니다. 다른 UUID의 비콘은 직접 입력하세요.")) {
            TextField("추가로 검색할 UUID (선택)", text: $model.extraUUID)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.system(.footnote, design: .monospaced))
            HStack {
                Button("검색 시작") { model.startScan() }.disabled(model.scanning)
                Spacer()
                Button("중지") { model.stopScan() }.disabled(!model.scanning)
            }
            .buttonStyle(.borderless)
            if let state = scannerMessage { Text(state).font(.caption).foregroundColor(.secondary) }
            if model.scanning && model.heard.isEmpty { Text("검색 중…").font(.caption).foregroundColor(.secondary) }
            ForEach(model.heard) { b in
                Button { model.pick(b) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.uuid.uppercased()).font(.system(.caption2, design: .monospaced))
                        Text("Major \(b.major) · Minor \(b.minor)")
                        Text("\(b.lastRssi.map(String.init) ?? "—") dBm (최대 \(b.maxRssi.map(String.init) ?? "—")) · \(b.count)회 · \(b.registered ? "등록됨" : "눌러서 채우기")")
                            .font(.caption).foregroundColor(.secondary)
                    }
                }
                .disabled(b.registered)
            }
        }
    }

    private var identitySection: some View {
        Section(header: Text("등록 정보")) {
            field("UUID", $model.form.uuid, "uuid", keyboard: .asciiCapable)
            HStack {
                field("Major", $model.form.major, "major", keyboard: .numberPad)
                field("Minor", $model.form.minor, "minor", keyboard: .numberPad)
            }
            field("1 m 송신 세기(dBm, 비우면 기본값)", $model.form.measuredPowerDbm, "measuredPowerDbm", keyboard: .numbersAndPunctuation)
            field("이름", $model.form.label, nil)
        }
    }

    private var placementSection: some View {
        Section(header: Text("설치 위치 (비우면 위치 없이 등록)"),
                footer: Text("설치 높이를 비우면 층 바닥 높이 + 바닥에서 높이로 계산합니다. 실내 GPS는 수십 m 틀릴 수 있습니다.")) {
            field("건물 ID (바깥이면 outdoor)", $model.form.buildingId, "buildingId")
            if !model.buildings.isEmpty {
                Picker("건물 목록", selection: $model.form.buildingId) {
                    Text("—").tag("")
                    Text("outdoor").tag("outdoor")
                    ForEach(model.buildings) { Text($0.buildingName).tag($0.buildingId) }
                }
            }
            HStack {
                field("층 (3F / B1)", $model.form.floor, "floor")
                field("층 바닥 높이(해발 m)", $model.form.floorHeightM, "floorHeightM", keyboard: .numbersAndPunctuation)
            }
            Picker("좌표", selection: $model.form.positionMode) {
                Text("위도·경도").tag("wgs84")
                Text("EPSG:5186").tag("grid")
            }
            .pickerStyle(.segmented)
            if model.form.positionMode == "grid" {
                HStack {
                    field("X (m)", $model.form.x, "x", keyboard: .numbersAndPunctuation)
                    field("Y (m)", $model.form.y, "y", keyboard: .numbersAndPunctuation)
                }
            } else {
                HStack {
                    field("위도", $model.form.latitude, "latitude", keyboard: .numbersAndPunctuation)
                    field("경도", $model.form.longitude, "longitude", keyboard: .numbersAndPunctuation)
                }
                Button("현재 위치 사용") { Task { await model.useCurrentLocation() } }
            }
            HStack {
                field("바닥에서 높이(m)", $model.form.mountAboveFloorM, nil, keyboard: .numbersAndPunctuation)
                field("설치 높이(해발 m)", $model.form.z, "z", keyboard: .numbersAndPunctuation)
            }
            field("위치 정확도(m)", $model.form.horizontalAccuracyM, "horizontalAccuracyM", keyboard: .numbersAndPunctuation)
        }
    }

    private var submitSection: some View {
        Section {
            HStack {
                Button(model.submitting ? "등록 중…" : "등록") { Task { await model.submit() } }
                    .disabled(model.submitting)
                Spacer()
                Button("비우기", role: .destructive) { model.clearForm() }
            }
            .buttonStyle(.borderless)
            if let message = model.message { Text(message).font(.callout) }
        }
    }

    private func field(_ title: String, _ text: Binding<String>, _ key: String?, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField(title, text: text)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
            if let key, let error = model.errors[key] { Text(error).font(.caption).foregroundColor(.red) }
        }
    }

    private var scannerMessage: String? {
        switch model.scannerState {
        case .notAuthorized: return "위치 권한(앱 사용 중)이 필요합니다."
        case .reducedAccuracy: return "정확한 위치가 꺼져 있으면 iOS가 비콘을 알려주지 않습니다."
        case .rangingUnavailable: return "이 기기는 비콘 검색을 지원하지 않습니다."
        case let .failed(reason): return "검색 실패: \(reason)"
        case .noRegisteredBeacons: return "검색할 UUID가 없습니다."
        case .idle, .ranging: return nil
        }
    }
}
