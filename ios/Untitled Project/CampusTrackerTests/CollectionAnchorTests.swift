import Foundation
import Testing
@testable import CampusTracker

/// Collection anchors (server markers/marker-anchor.ts): picker rules and the marker wire format.
struct CollectionAnchorTests {
    @Test func floorsFollowTheServerRule() {
        #expect(AnchorRules.floors.first == "B6")
        #expect(AnchorRules.floors.last == "15F")
        #expect(!AnchorRules.floors.contains("0F"))
        #expect(AnchorRules.floors.allSatisfy { AnchorRules.isFloor($0) })
        #expect(AnchorRules.floorNumber("B2") == -2)
        #expect(AnchorRules.floorNumber("12F") == 12)
        #expect(AnchorRules.direction(from: "B1", to: "3F") == "up")
        #expect(AnchorRules.direction(from: "3F", to: "3F") == nil)
    }

    @Test func startNeedsBuildingFloorAndNodeUnlessTheFloorHasNone() {
        #expect(!AnchorRules.isComplete(.sessionStart, CollectionAnchor(buildingId: "북악관", floor: "3F"), nodesOnOffer: true))
        #expect(AnchorRules.isComplete(.sessionStart, CollectionAnchor(nodeId: "n", buildingId: "북악관", floor: "3F"), nodesOnOffer: true))
        #expect(AnchorRules.isComplete(.sessionStart, CollectionAnchor(buildingId: "한림관", floor: "B1"), nodesOnOffer: false))
        #expect(!AnchorRules.isComplete(.sessionEnd, CollectionAnchor(buildingId: CollectionAnchor.outdoor), nodesOnOffer: false))
        #expect(!AnchorRules.isComplete(.entrance, CollectionAnchor(nodeId: "n", buildingId: CollectionAnchor.outdoor), nodesOnOffer: true))
        #expect(AnchorRules.isComplete(.stairStart, CollectionAnchor(direction: "up", fromFloor: "1F", toFloor: "3F"), nodesOnOffer: true))
        #expect(!AnchorRules.isComplete(.elevatorExit, CollectionAnchor(fromFloor: "B2"), nodesOnOffer: true))
        #expect(AnchorRules.isComplete(.stop, CollectionAnchor(), nodesOnOffer: true))
    }

    @Test func markerPayloadCarriesTheAnchorAndOlderMarkersStillDecode() throws {
        let marker = EventMarker(id: UUID(), sessionId: UUID(), timestamp: Date(), type: .stairStart, note: nil,
                                 latitude: 37.61, longitude: 127.0, altitude: nil, horizontalAccuracy: nil, verticalAccuracy: nil,
                                 anchor: CollectionAnchor(direction: "up", fromFloor: "3F", toFloor: "4F"))
        let json = try JSONSerialization.jsonObject(with: TrackingJSONCodec.makeEncoder().encode(MarkerPayload(marker: marker))) as! [String: Any]
        #expect(json["direction"] as? String == "up")
        #expect(json["toFloor"] as? String == "4F")
        #expect(json["nodeId"] == nil)
        // a marker stored by an older build (no anchor, "elevator" type) still decodes
        let old = #"{"id":"7F6C4B4E-8A9E-4C55-9D4C-3F1F0A3B9E11","sessionId":"1B0E2A4C-3D5F-4A6B-8C7D-9E0F1A2B3C4D","timestamp":"2026-10-15T01:00:00.000Z","type":"elevator"}"#
        let decoded = try TrackingJSONCodec.makeDecoder().decode(EventMarker.self, from: Data(old.utf8))
        #expect(decoded.type == .elevator)
        #expect(decoded.anchor == nil)
    }
}
