package hoshi.campustracker.model

import kotlinx.serialization.Serializable

/**
 * Declared route (사용자 지정 길, server `mobility/declared-route.ts`): before Start the collector says which way they will
 * walk — network nodes in order (start, via points, end) and how each leg is walked — then walks it. Sent with
 * session:start as the session's ground-truth path.
 */
@Serializable
data class RoutePoint(
    val nodeId: String,
    /** the node's label from the picker (place or road name · structure) */
    val label: String,
    val buildingId: String? = null,
    val floor: String? = null,
)

/** How the leg to the next point is walked: walk, stairs (direction up/down) or elevator (fromFloor → toFloor). */
@Serializable
data class RouteSegment(
    val mode: String = WALK,
    val direction: String? = null,
    val fromFloor: String? = null,
    val toFloor: String? = null,
) {
    companion object {
        const val WALK = "walk"
        const val STAIRS = "stairs"
        const val ELEVATOR = "elevator"
    }
}

/** The route as planned on the phone (also what a saved route keeps). segments[i] = leg from points[i] to points[i + 1]. */
@Serializable
data class PlannedRoute(
    val points: List<RoutePoint> = emptyList(),
    val segments: List<RouteSegment> = emptyList(),
    /** saved routes only */
    val name: String? = null,
)

/** `declaredRoute` on session:start (wire). */
@Serializable
data class DeclaredRoute(val nodeKeys: List<String>, val segments: List<RouteSegment>, val text: String? = null)

object RouteRules {
    const val MAX_POINTS = 50
    private const val MAX_TEXT = 500

    fun segment(route: PlannedRoute, leg: Int): RouteSegment = route.segments.getOrNull(leg) ?: RouteSegment()

    fun isSegmentComplete(s: RouteSegment): Boolean = when (s.mode) {
        RouteSegment.WALK -> true
        RouteSegment.STAIRS -> (s.direction == "up" || s.direction == "down") &&
            (s.fromFloor == null || AnchorRules.isFloor(s.fromFloor)) && (s.toFloor == null || AnchorRules.isFloor(s.toFloor))
        RouteSegment.ELEVATOR -> AnchorRules.isFloor(s.fromFloor) && AnchorRules.isFloor(s.toFloor)
        else -> false
    }

    /** Two to [MAX_POINTS] points, every leg complete. */
    fun isComplete(route: PlannedRoute): Boolean =
        route.points.size in 2..MAX_POINTS && (0 until route.points.size - 1).all { isSegmentComplete(segment(route, it)) }

    fun addPoint(route: PlannedRoute, point: RoutePoint): PlannedRoute {
        if (route.points.size >= MAX_POINTS) return route
        val legs = route.points.size // legs before the new point = new leg index
        val segments = (0 until legs).map { segment(route, it) }
        return route.copy(points = route.points + point, segments = segments)
    }

    fun removeLastPoint(route: PlannedRoute): PlannedRoute {
        if (route.points.isEmpty()) return route
        val points = route.points.dropLast(1)
        return route.copy(points = points, segments = route.segments.take(maxOf(0, points.size - 1)))
    }

    fun setSegment(route: PlannedRoute, leg: Int, s: RouteSegment): PlannedRoute {
        if (leg !in 0 until route.points.size - 1) return route
        val segments = (0 until route.points.size - 1).map { if (it == leg) s else segment(route, it) }
        return route.copy(segments = segments)
    }

    fun describeSegment(s: RouteSegment): String? = when (s.mode) {
        RouteSegment.STAIRS -> listOfNotNull(
            if (s.direction == "down") "계단 하행" else "계단 상행",
            if (s.fromFloor != null && s.toFloor != null) "${s.fromFloor}→${s.toFloor}" else null,
        ).joinToString(" ")
        RouteSegment.ELEVATOR -> "승강기 ${s.fromFloor}→${s.toFloor}"
        else -> null
    }

    fun describePoint(p: RoutePoint): String = listOfNotNull(p.floor, p.label).joinToString(" ")

    /** "3F 복도 → 계단 상행 → 5F 복도 → 승강기 5F→1F → 정문" (walk legs are just arrows). */
    fun describe(route: PlannedRoute): String = buildString {
        route.points.forEachIndexed { i, p ->
            if (i > 0) {
                append(" → ")
                describeSegment(segment(route, i - 1))?.let { append(it).append(" → ") }
            }
            append(describePoint(p))
        }
    }

    fun toWire(route: PlannedRoute): DeclaredRoute = DeclaredRoute(
        nodeKeys = route.points.map { it.nodeId },
        segments = (0 until route.points.size - 1).map { segment(route, it) },
        text = describe(route).take(MAX_TEXT).ifBlank { null },
    )

    /** The start anchor the route implies (its first point). */
    fun startAnchor(route: PlannedRoute): CollectionAnchor? = route.points.firstOrNull()?.let {
        CollectionAnchor(nodeId = it.nodeId, buildingId = it.buildingId, floor = it.floor, nodeLabel = it.label)
    }

    /** The point after [reached] (index of the last point reached; 0 = the start), or null at the end. */
    fun next(route: PlannedRoute, reached: Int): RoutePoint? = route.points.getOrNull(reached + 1)

    /** Progress after standing on [nodeId]: the next point when it is that node, else unchanged. */
    fun advance(route: PlannedRoute, reached: Int, nodeId: String?): Int =
        if (nodeId != null && next(route, reached)?.nodeId == nodeId) reached + 1 else reached
}
