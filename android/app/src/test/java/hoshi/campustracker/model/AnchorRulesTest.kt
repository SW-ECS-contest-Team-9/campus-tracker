package hoshi.campustracker.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnchorRulesTest {
    @Test
    fun floorsFollowTheServerRule() {
        assertEquals("B6", AnchorRules.FLOORS.first())
        assertEquals("15F", AnchorRules.FLOORS.last())
        assertFalse("0F" in AnchorRules.FLOORS)
        assertTrue(AnchorRules.FLOORS.all(AnchorRules::isFloor))
        assertEquals(-2, AnchorRules.floorNumber("B2"))
        assertEquals(12, AnchorRules.floorNumber("12F"))
        assertNull(AnchorRules.floorNumber("지하1층"))
        assertEquals("up", AnchorRules.direction("B1", "3F"))
        assertEquals("down", AnchorRules.direction("3F", "2F"))
        assertNull(AnchorRules.direction("3F", "3F"))
    }

    @Test
    fun startNeedsBuildingFloorAndNodeUnlessTheFloorHasNone() {
        val start = EventMarkerType.sessionStart
        assertFalse(AnchorRules.isComplete(start, CollectionAnchor(), nodesOnOffer = true))
        assertFalse(AnchorRules.isComplete(start, CollectionAnchor(buildingId = "북악관"), nodesOnOffer = true))
        assertFalse(AnchorRules.isComplete(start, CollectionAnchor(buildingId = "북악관", floor = "3F"), nodesOnOffer = true))
        assertTrue(AnchorRules.isComplete(start, CollectionAnchor(buildingId = "북악관", floor = "3F", nodeId = "n"), nodesOnOffer = true))
        // a floor with no indoor node: building + floor is enough
        assertTrue(AnchorRules.isComplete(start, CollectionAnchor(buildingId = "한림관", floor = "B1"), nodesOnOffer = false))
        // outside: always a node
        assertFalse(AnchorRules.isComplete(start, CollectionAnchor(buildingId = CollectionAnchor.OUTDOOR), nodesOnOffer = false))
        assertTrue(AnchorRules.isComplete(EventMarkerType.sessionEnd, CollectionAnchor(buildingId = CollectionAnchor.OUTDOOR, nodeId = "n"), nodesOnOffer = true))
        // an entrance is on a building floor
        assertFalse(AnchorRules.isComplete(EventMarkerType.entrance, CollectionAnchor(buildingId = CollectionAnchor.OUTDOOR, nodeId = "n"), nodesOnOffer = true))
    }

    @Test
    fun stairsElevatorsAndRampsNeedTheirFields() {
        val up = CollectionAnchor(direction = "up", fromFloor = "1F", toFloor = "3F")
        assertTrue(AnchorRules.isComplete(EventMarkerType.stairStart, up, nodesOnOffer = true))
        assertFalse(AnchorRules.isComplete(EventMarkerType.stairEnd, up.copy(direction = null), nodesOnOffer = true))
        assertTrue(AnchorRules.isComplete(EventMarkerType.elevatorBoard, CollectionAnchor(fromFloor = "B2", toFloor = "5F"), nodesOnOffer = true))
        assertFalse(AnchorRules.isComplete(EventMarkerType.elevatorExit, CollectionAnchor(fromFloor = "B2"), nodesOnOffer = true))
        assertTrue(AnchorRules.isComplete(EventMarkerType.rampEnd, CollectionAnchor(direction = "down"), nodesOnOffer = true))
        assertTrue(AnchorRules.isComplete(EventMarkerType.stop, CollectionAnchor(), nodesOnOffer = true))
    }
}
