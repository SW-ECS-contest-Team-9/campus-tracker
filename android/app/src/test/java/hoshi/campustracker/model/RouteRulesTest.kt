package hoshi.campustracker.model

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.persistence.SavedRoutesStore
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RouteRulesTest {
    @get:Rule val tmp = TemporaryFolder()

    private val a = RoutePoint("n-a", "정문 · 길", "outdoor", null)
    private val b = RoutePoint("n-b", "로비 · 복도", "본관", "1F")
    private val c = RoutePoint("n-c", "301호 · 복도", "본관", "3F")

    private fun route(vararg points: RoutePoint) = points.fold(PlannedRoute()) { r, p -> RouteRules.addPoint(r, p) }

    @Test
    fun legsFollowThePointsAndDefaultToWalking() {
        val r = route(a, b, c)
        assertEquals(listOf(RouteSegment(), RouteSegment()), r.segments)
        assertTrue(RouteRules.isComplete(r))
        assertFalse(RouteRules.isComplete(route(a)))
        val stairs = RouteRules.setSegment(r, 1, RouteSegment(RouteSegment.STAIRS, direction = "up"))
        assertEquals(RouteSegment(RouteSegment.STAIRS, direction = "up"), RouteRules.segment(stairs, 1))
        assertEquals(stairs, RouteRules.setSegment(stairs, 5, RouteSegment())) // no such leg
        val shorter = RouteRules.removeLastPoint(stairs)
        assertEquals(listOf(a, b), shorter.points)
        assertEquals(listOf(RouteSegment()), shorter.segments)
    }

    @Test
    fun anElevatorLegNeedsBothFloorsAndStairsADirection() {
        val r = route(b, c)
        assertFalse(RouteRules.isComplete(RouteRules.setSegment(r, 0, RouteSegment(RouteSegment.ELEVATOR, fromFloor = "1F"))))
        assertTrue(RouteRules.isComplete(RouteRules.setSegment(r, 0, RouteSegment(RouteSegment.ELEVATOR, fromFloor = "1F", toFloor = "3F"))))
        assertFalse(RouteRules.isComplete(RouteRules.setSegment(r, 0, RouteSegment(RouteSegment.STAIRS))))
        assertFalse(RouteRules.isComplete(RouteRules.setSegment(r, 0, RouteSegment("escalator"))))
    }

    @Test
    fun wireFormMatchesTheContract() {
        val r = RouteRules.setSegment(route(a, b, c), 1, RouteSegment(RouteSegment.ELEVATOR, fromFloor = "1F", toFloor = "3F"))
        val wire = RouteRules.toWire(r)
        assertEquals(listOf("n-a", "n-b", "n-c"), wire.nodeKeys)
        assertEquals("정문 · 길 → 1F 로비 · 복도 → 승강기 1F→3F → 3F 301호 · 복도", wire.text)
        assertEquals(
            Json.parseToJsonElement(
                """{"nodeKeys":["n-a","n-b","n-c"],"segments":[{"mode":"walk"},{"mode":"elevator","fromFloor":"1F","toFloor":"3F"}],
                   "text":"정문 · 길 → 1F 로비 · 복도 → 승강기 1F→3F → 3F 301호 · 복도"}""",
            ),
            Json.parseToJsonElement(AppJson.encodeToString(DeclaredRoute.serializer(), wire)),
        )
        assertEquals(CollectionAnchor(nodeId = "n-a", buildingId = "outdoor", nodeLabel = "정문 · 길"), RouteRules.startAnchor(r))
    }

    @Test
    fun progressMovesOnOnlyAtTheNextPoint() {
        val r = route(a, b, c)
        assertEquals(b, RouteRules.next(r, 0))
        assertEquals(0, RouteRules.advance(r, 0, "n-c")) // skipping ahead is not arriving
        assertEquals(0, RouteRules.advance(r, 0, null))
        assertEquals(1, RouteRules.advance(r, 0, "n-b"))
        assertEquals(2, RouteRules.advance(r, 1, "n-c"))
        assertNull(RouteRules.next(r, 2))
    }

    @Test
    fun aRoutePointMustBeANode() {
        val t = EventMarkerType.routeWaypoint
        assertEquals(AnchorNeeds.PLACE, AnchorRules.needs(t))
        // a floor without nodes takes building + floor for Start, never for a route point
        assertTrue(AnchorRules.isComplete(EventMarkerType.sessionStart, CollectionAnchor(buildingId = "본관", floor = "2F"), nodesOnOffer = false))
        assertFalse(AnchorRules.isComplete(t, CollectionAnchor(buildingId = "본관", floor = "2F"), nodesOnOffer = false))
        assertTrue(AnchorRules.isComplete(t, CollectionAnchor(nodeId = "n", buildingId = "본관", floor = "2F"), nodesOnOffer = true))
    }

    @Test
    fun savedRoutesSurviveAReloadAndReplaceByName() {
        val root = tmp.newFolder()
        val store = SavedRoutesStore(root)
        assertEquals(emptyList<PlannedRoute>(), store.load())
        store.save(route(a, b).copy(name = " 정문→로비 "))
        store.save(route(b, c).copy(name = "로비→3층"))
        store.save(route(a, c).copy(name = "정문→로비"))
        val again = SavedRoutesStore(root).load()
        assertEquals(listOf("로비→3층", "정문→로비"), again.map { it.name })
        assertEquals(listOf(a, c), again.last().points)
        assertEquals(listOf("정문→로비"), store.delete("로비→3층").map { it.name })
        // a corrupt file is set aside, not fatal
        File(root, "saved_routes.json").writeText("{not json")
        assertEquals(emptyList<PlannedRoute>(), store.load())
        assertTrue(root.listFiles()!!.any { it.name.startsWith("saved_routes.corrupt-") })
    }
}
