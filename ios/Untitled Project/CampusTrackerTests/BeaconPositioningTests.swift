import Foundation
import SQLite3
import Testing
@testable import CampusTracker

// BLE beacon positioning (docs/BEACON_POSITIONING.md). The fixture files under fixtures/beacon are shared with the
// server and Android tests, read from the repository checkout (#filePath).

private func fixture(_ name: String) throws -> Data {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    return try Data(contentsOf: root.appendingPathComponent("fixtures/beacon/\(name)"))
}

private nonisolated struct ModelFixture: Decodable {
    struct Case: Decodable { let rssi: Double; let measuredPower1m: Double; let pathLossExponent: Double; let rssiVariance: Double
        let expectedRangeM: Double; let expectedLnSigma: Double }
    struct Selection: Decodable { let beaconId: String; let platform: String; let deviceModel: String; let advertised: Int?
        let expectedSource: String; let expectedMeasuredPower1m: Double }
    let defaults: RssiDefaults
    let modelCases: [Case]
    let calibrationRows: [BeaconCalibration]
    let selectionCases: [Selection]
}

struct BeaconModelTests {
    @Test func sharedMeasurementModelFixture() throws {
        let f = try JSONDecoder().decode(ModelFixture.self, from: try fixture("measurement-model.json"))
        #expect(f.defaults == RssiDefaults())
        for c in f.modelCases {
            let m = RssiModel(measuredPower1m: c.measuredPower1m, pathLossExponent: c.pathLossExponent, rssiVariance: c.rssiVariance, source: "T")
            #expect(abs(m.range(rssi: c.rssi) - c.expectedRangeM) < 1e-5)
            #expect(abs(m.lnRangeSigma - c.expectedLnSigma) < 1e-5)
        }
        for c in f.selectionCases {
            let m = RssiModel.select(rows: f.calibrationRows, beaconId: c.beaconId, platform: c.platform, deviceModel: c.deviceModel, advertisedPower: c.advertised)
            #expect(m.source == c.expectedSource)
            #expect(m.measuredPower1m == c.expectedMeasuredPower1m)
        }
    }

    @Test func clBeaconValuesBecomeObservationsOrAreDropped() {
        let uuid = UUID(uuidString: "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0")!
        let t = Date(timeIntervalSince1970: 1_790_000_000)
        let o = BeaconObservationAdapter.observation(uuid: uuid, major: 1, minor: 2, rssi: -71, accuracy: 3.2, proximity: "near", timestamp: t, id: "x")
        #expect(o?.uuid == "e2c56db5-dffb-48d2-b060-d0f5a71096e0")
        #expect(o?.key == "IBEACON:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2")
        #expect(o?.rssiAggregation == RssiAggregation.coreLocationRanging)
        #expect(o?.platformEstimatedDistanceMeters == 3.2)
        #expect(o?.observedAt == t)
        // Core Location reports rssi 0 when unknown and accuracy -1 when it cannot estimate
        #expect(BeaconObservationAdapter.observation(uuid: uuid, major: 1, minor: 2, rssi: 0, accuracy: 1, proximity: "unknown", timestamp: t) == nil)
        #expect(BeaconObservationAdapter.observation(uuid: uuid, major: 1, minor: 2, rssi: -80, accuracy: -1, proximity: "unknown", timestamp: t)?.platformEstimatedDistanceMeters == nil)
        #expect(BeaconObservationAdapter.observation(uuid: uuid, major: 70_000, minor: 2, rssi: -80, accuracy: 1, proximity: "far", timestamp: t) == nil)
    }

    @Test func wireRowUsesTheServerContract() throws {
        let o = BeaconObservation(observationId: "o1", uuid: "e2c56db5-dffb-48d2-b060-d0f5a71096e0", major: 1, minor: 2, rssiDbm: -70,
                                  observedAt: Date(timeIntervalSince1970: 1_790_000_000.123), rssiAggregation: RssiAggregation.coreLocationRanging)
        let json = try JSONSerialization.jsonObject(with: TrackingJSONCodec.makeEncoder().encode(o)) as? [String: Any]
        #expect(json?["protocol"] as? String == "IBEACON")
        #expect((json?["observedAt"] as? String)?.hasSuffix(".123Z") == true)
    }

    @Test func rssiWindowFilter() {
        var f = BeaconMeasurementFilter()
        let model = RssiModel.select(rows: [], beaconId: nil, platform: "ios", deviceModel: nil, advertisedPower: nil)
        let t0 = Date(timeIntervalSince1970: 1_000)
        var ok = 0
        for i in 0..<6 { if case .success = f.add(key: "k", time: t0.addingTimeInterval(Double(i) * 0.25), rssi: -75 + Double(i % 2), sampleCount: 1, model: model) { ok += 1 } }
        #expect(ok == 2)
        #expect(f.add(key: "k", time: t0.addingTimeInterval(1.6), rssi: -50, sampleCount: 1, model: model) == .failure(.rssiOutlier))
        #expect(f.add(key: "k", time: t0.addingTimeInterval(2), rssi: 0, sampleCount: 1, model: model) == .failure(.rssiOutOfRange))
        #expect(f.add(key: "k", time: t0.addingTimeInterval(-10), rssi: -70, sampleCount: 1, model: model) == .failure(.stale))
        #expect(f.add(key: "far", time: t0.addingTimeInterval(2), rssi: -99, sampleCount: 1, model: model) == .failure(.tooFar))
        f.reset()
        if case let .success(m) = f.add(key: "k", time: t0.addingTimeInterval(20), rssi: -60, sampleCount: 10, model: model) {
            #expect(m.samples == 3)
            #expect(m.medianRssi == -60)
        } else { Issue.record("fresh window after reset must measure") }
    }
}

private nonisolated final class MemoryConfigStorage: BeaconConfigStorage, @unchecked Sendable {
    var value: CachedBeaconConfig?
    func loadBeaconConfig(serverKey: String) throws -> CachedBeaconConfig? { value?.serverKey == serverKey ? value : nil }
    func saveBeaconConfig(_ cached: CachedBeaconConfig) throws { value = cached }
}

struct BeaconRegistryCacheTests {
    @Test func configParsesAndResolvesIdentities() throws {
        let config = try JSONDecoder().decode(BeaconConfig.self, from: try fixture("beacon-config.json"))
        let registry = BeaconRegistry(config: config)
        let beacon = try #require(registry.lookup(uuid: "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0", major: 1, minor: 2))
        #expect(beacon.anchor?.floor == "3F")
        #expect(registry.model(for: beacon, deviceModel: "iPhone15,2").source == "BEACON_PLATFORM")
        #expect(registry.model(for: beacon, platform: "android", deviceModel: "Pixel 8").source == "ADVERTISED")
        #expect(registry.proximityUUIDs.count == 1)
    }

    @Test func freshSkipsNotModifiedTouchesAndOfflineKeepsTheCache() async throws {
        let body = try fixture("beacon-config.json")
        let storage = MemoryConfigStorage()
        let cache = BeaconConfigCache(storage: storage)
        var now = Date(timeIntervalSince1970: 1_000_000)
        var lastEtag: String? = "unset"
        let first = await cache.refresh(serverKey: "s", now: now) { etag in lastEtag = etag; return BeaconConfigResponse(status: 200, etag: "W/\"v7\"", body: body) }
        guard case .updated = first else { Issue.record("expected updated"); return }
        #expect(lastEtag == nil)
        let skipped = await cache.refresh(serverKey: "s", now: now.addingTimeInterval(10)) { _ in Issue.record("fresh: no request"); throw URLError(.badURL) }
        guard case .skipped = skipped else { Issue.record("expected skipped"); return }
        now = now.addingTimeInterval(3_601)
        #expect(cache.freshness(storage.value, now: now) == .staleUsable)
        let revalidated = await cache.refresh(serverKey: "s", now: now) { etag in lastEtag = etag; return BeaconConfigResponse(status: 304, etag: etag, body: nil) }
        guard case .notModified = revalidated else { Issue.record("expected 304"); return }
        #expect(lastEtag == "W/\"v7\"")
        now = now.addingTimeInterval(3_601)
        let offline = await cache.refresh(serverKey: "s", now: now) { _ in throw URLError(.notConnectedToInternet) }
        guard case let .failed(kept, _) = offline else { Issue.record("expected failure"); return }
        #expect(kept?.config.configVersion == 7, "the server being down never drops the cached registry")
        #expect(cache.freshness(storage.value, now: now.addingTimeInterval(15 * 86_400)) == .expired)
        #expect((try storage.loadBeaconConfig(serverKey: "other")) == nil)
    }

    @Test func collectionPolicy() {
        let config = BeaconConfig(schemaVersion: 1, configVersion: 3, features: BeaconFeatures(scanning: true, upload: true),
                                  proximityUuids: ["E2C56DB5-DFFB-48D2-B060-D0F5A71096E0"])
        let cached = CachedBeaconConfig(config: config, etag: nil, fetchedAt: Date(), serverKey: "s")
        #expect(BeaconCollectionPolicy.decide(activeSession: false, localScanning: true, localUpload: true, cached: cached, freshness: .fresh).reason == "NO_ACTIVE_SESSION")
        #expect(BeaconCollectionPolicy.decide(activeSession: true, localScanning: false, localUpload: true, cached: cached, freshness: .fresh).reason == "LOCAL_SWITCH_OFF")
        #expect(BeaconCollectionPolicy.decide(activeSession: true, localScanning: true, localUpload: true, cached: nil, freshness: .missing).reason == "NO_CONFIG")
        let ok = BeaconCollectionPolicy.decide(activeSession: true, localScanning: true, localUpload: true, cached: cached, freshness: .staleUsable)
        #expect(ok.scan && ok.upload && ok.uuids == ["e2c56db5-dffb-48d2-b060-d0f5a71096e0"])
        var off = config; off.features = BeaconFeatures(scanning: false)
        let remoteOff = CachedBeaconConfig(config: off, etag: nil, fetchedAt: Date(), serverKey: "s")
        #expect(BeaconCollectionPolicy.decide(activeSession: true, localScanning: true, localUpload: true, cached: remoteOff, freshness: .fresh).reason == "SERVER_SWITCH_OFF")
    }
}

// MARK: - SQLite (collection-v2.sqlite schema 2)

@MainActor
struct BeaconStoreTests {
    private func observation(_ i: Int) -> BeaconObservation {
        BeaconObservation(observationId: "obs-\(i)", uuid: "e2c56db5-dffb-48d2-b060-d0f5a71096e0", major: 1, minor: 2, rssiDbm: -70 - i,
                          observedAt: Date(timeIntervalSince1970: 1_790_000_000 + Double(i)), rssiAggregation: RssiAggregation.coreLocationRanging)
    }

    @Test func version1DatabaseUpgradesInPlaceKeepingSessionsAndLedger() throws {
        let directory = TestFixture.tempDirectory("BeaconMigration")
        // A database written by the previous build: schema 1 tables only, user_version 1, one session + one item.
        var store: CollectionStore? = CollectionStore(directory: directory)
        let session = TestFixture.session()
        try TestFixture.seed(store!, session: session)
        let marker = try TestFixture.insert(store!, session: session, TestFixture.markerDraft(session: session))
        try store!.sync { access in
            _ = try access.count("sessions")
        }
        store = nil
        let path = directory.appendingPathComponent(CollectionStore.databaseFileName).path
        var db: OpaquePointer?
        #expect(sqlite3_open(path, &db) == SQLITE_OK)
        sqlite3_exec(db, "DROP TABLE beacon_observations; DROP TABLE beacon_config_cache; PRAGMA user_version = 1;", nil, nil, nil)
        sqlite3_close(db)

        let reopened = CollectionStore(directory: directory)
        #expect(try reopened.sync { try $0.count("sessions") } == 1)
        #expect(try reopened.sync { try $0.item(kind: .marker, itemID: marker.itemID)?.state } == .pending)
        #expect(try reopened.sync { try $0.count("beacon_observations") } == 0)
        #expect(try reopened.sync { try $0.count("beacon_config_cache") } == 0)
    }

    @Test func beaconRowsAndTheirUploadItemCommitTogether() throws {
        let failures = StoreFailureSwitch()
        let store = CollectionStore(directory: TestFixture.tempDirectory("BeaconCommit"), failureInjector: failures.injector)
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        let rows = (0..<3).map(observation)
        failures.fail(.uploadInsert)
        #expect(throws: CollectionStoreError.self) {
            _ = try store.sync { try $0.commitBeaconBatch(sessionID: session.id, batchID: "b1", observations: rows, payload: Data("{}".utf8)) }
        }
        #expect(try store.sync { try $0.count("beacon_observations") } == 0, "no rows without their upload item")
        let item = try store.sync { try $0.commitBeaconBatch(sessionID: session.id, batchID: "b1", observations: rows, payload: Data("{}".utf8)) }
        #expect(item.kind == .beacon && item.state == .pending)
        // a retried commit of the same observations does not duplicate rows
        _ = try store.sync { try $0.commitBeaconBatch(sessionID: session.id, batchID: "b2", observations: rows, payload: Data("{}".utf8)) }
        #expect(try store.sync { try $0.beaconObservations(sessionID: session.id) }.map(\.observationId) == ["obs-0", "obs-1", "obs-2"])
    }

    @Test func registryCacheRoundTripsThroughSQLite() throws {
        let store = CollectionStore(directory: TestFixture.tempDirectory("BeaconConfig"))
        let config = try JSONDecoder().decode(BeaconConfig.self, from: try fixture("beacon-config.json"))
        let cached = CachedBeaconConfig(config: config, etag: "W/\"v7\"", fetchedAt: Date(timeIntervalSince1970: 1_790_000_000), serverKey: "http://s:3000")
        try store.sync { try $0.saveBeaconConfig(cached) }
        #expect(try store.sync { try $0.loadBeaconConfig(serverKey: "http://s:3000") } == cached)
        #expect(try store.sync { try $0.loadBeaconConfig(serverKey: "http://other:3000") } == nil)
    }
}

// MARK: - Upload (feature-gated, never blocking the session)

@MainActor
struct BeaconUploadTests {
    private func beaconItem(_ store: CollectionStore, _ session: CollectionSession, batch: String = UUID().uuidString) throws -> UploadItemRecord {
        let payload = BeaconObservationBatchPayload(batchId: batch, sessionId: nil, clientSessionId: session.id.uuidString, deviceModel: "iPhone15,2",
                                                    createdAt: Date(), observations: [BeaconObservation(observationId: UUID().uuidString,
                                                    uuid: "e2c56db5-dffb-48d2-b060-d0f5a71096e0", major: 1, minor: 2, rssiDbm: -70,
                                                    observedAt: Date(), rssiAggregation: RssiAggregation.coreLocationRanging)])
        return try store.sync { try $0.commitBeaconBatch(sessionID: session.id, batchID: batch, observations: payload.observations,
                                                          payload: try TrackingJSONCodec.makeEncoder().encode(payload)) }
    }

    private func connected(features: [String]) async throws -> (MockCollectorSocket, TelemetryUploadEngine, CollectionStore, CollectionSession) {
        let store = CollectionStore(directory: TestFixture.tempDirectory("BeaconUpload"))
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        let socket = MockCollectorSocket()
        let engine = TelemetryUploadEngine(webSocket: socket, store: store)
        await waitUntil { engine.isLoaded }
        engine.updateOwner(TestFixture.owner)
        engine.activate(sessionID: session.id)
        socket.connect()
        await waitUntil { socket.count("session:start") == 1 }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1", "supportedTelemetryFeatures": features])
        try? await Task.sleep(nanoseconds: 30_000_000)
        return (socket, engine, store, session)
    }

    @Test func sentWithTheServerSessionIdWhenTheServerAdvertisesTheFeature() async throws {
        let (socket, engine, store, session) = try await connected(features: ["absoluteAltitudeV1", "beaconObservationsV1"])
        let item = try beaconItem(store, session)
        engine.ingest([item])
        await waitUntil { socket.count("beacon.observations.v1") == 1 }
        let sent = try #require(socket.sent.last { $0.type == "beacon.observations.v1" })
        #expect(sent.payload["sessionId"] as? String == "server-session-1")
        #expect(sent.payload["schemaVersion"] as? Int == 1)
        #expect(sent.payload["platform"] as? String == "ios")
        socket.ack(type: "beacon.observations.v1", ok: true, data: ["batchId": item.itemID, "duplicate": false])
        await waitUntil { (try? store.sync { try $0.item(kind: .beacon, itemID: item.itemID)?.state }) == .acked }
        #expect(try store.sync { try $0.item(kind: .beacon, itemID: item.itemID)?.state } == .acked)
    }

    @Test func olderServerNeverReceivesBeaconsAndTheyAreNotPendingTelemetry() async throws {
        let (socket, engine, store, session) = try await connected(features: ["absoluteAltitudeV1"])
        let item = try beaconItem(store, session)
        engine.ingest([item])
        // one re-handshake to learn the feature list of this process, then nothing
        await waitUntil { socket.count("session:start") == 2 }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1", "supportedTelemetryFeatures": ["absoluteAltitudeV1"]])
        try? await Task.sleep(nanoseconds: 80_000_000)
        #expect(socket.count("beacon.observations.v1") == 0)
        #expect(engine.pendingCount == 0, "held optional data is not shown as pending telemetry")
        #expect(try store.sync { try $0.item(kind: .beacon, itemID: item.itemID)?.state } == .pending, "kept, not quarantined")
    }

    @Test func serverTurningBeaconsOffHoldsTheBatchWithoutQuarantine() async throws {
        let (socket, engine, store, session) = try await connected(features: ["beaconObservationsV1"])
        let item = try beaconItem(store, session)
        engine.ingest([item])
        await waitUntil { socket.count("beacon.observations.v1") == 1 }
        socket.ack(type: "beacon.observations.v1", ok: false, error: ["code": "BEACON_DISABLED", "status": 503, "retryable": false])
        try? await Task.sleep(nanoseconds: 80_000_000)
        #expect(socket.count("beacon.observations.v1") == 1)
        #expect(try store.sync { try $0.item(kind: .beacon, itemID: item.itemID)?.state } == .pending)
    }
}
