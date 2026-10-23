package hoshi.campustracker.model

/**
 * Where the collector really was when a marker was pressed (server `markers/marker-anchor.ts`): the ground truth for
 * training the location correction and a height fix point for fusion. Every field is optional on the wire.
 */
data class CollectionAnchor(
    val nodeId: String? = null,
    /** campus building id, or [OUTDOOR] */
    val buildingId: String? = null,
    val floor: String? = null,
    /** stairs and ramps: "up" or "down" */
    val direction: String? = null,
    val fromFloor: String? = null,
    val toFloor: String? = null,
    /** for the list only (not sent): the node's label */
    val nodeLabel: String? = null,
) {
    companion object {
        const val OUTDOOR = "outdoor"
    }
}

/** What a marker type asks the collector for. */
enum class AnchorNeeds { NONE, PLACE, STAIRS, ELEVATOR, RAMP }

object AnchorRules {
    /** Floor names the pickers offer: B6 … B1, 1F … 15F (no 0F; matches the server's 1F/B1 rule). */
    val FLOORS: List<String> = (6 downTo 1).map { "B$it" } + (1..15).map { "${it}F" }

    private val FLOOR = Regex("^(B[1-9]|[1-9][0-9]?F)$")
    fun isFloor(value: String?) = value != null && FLOOR.matches(value)

    fun needs(type: EventMarkerType): AnchorNeeds = when (type) {
        EventMarkerType.sessionStart, EventMarkerType.sessionEnd, EventMarkerType.entrance, EventMarkerType.routeWaypoint -> AnchorNeeds.PLACE
        EventMarkerType.stairStart, EventMarkerType.stairEnd -> AnchorNeeds.STAIRS
        EventMarkerType.elevatorBoard, EventMarkerType.elevatorExit -> AnchorNeeds.ELEVATOR
        EventMarkerType.rampStart, EventMarkerType.rampEnd -> AnchorNeeds.RAMP
        else -> AnchorNeeds.NONE
    }

    /**
     * Whether the marker may be recorded. A place needs the building and floor, plus a node when the list for that floor
     * has any (a floor without indoor nodes takes building + floor only); outside, a node is always required.
     * An entrance is always on a building floor. A route point is always a node (the route is drawn on the network).
     */
    fun isComplete(type: EventMarkerType, a: CollectionAnchor, nodesOnOffer: Boolean): Boolean = when (needs(type)) {
        AnchorNeeds.NONE -> true
        AnchorNeeds.PLACE -> when {
            a.buildingId == null -> false
            a.buildingId == CollectionAnchor.OUTDOOR -> type != EventMarkerType.entrance && a.nodeId != null
            !isFloor(a.floor) -> false
            else -> a.nodeId != null || (!nodesOnOffer && type != EventMarkerType.routeWaypoint)
        }
        AnchorNeeds.STAIRS -> (a.direction == "up" || a.direction == "down") && isFloor(a.fromFloor) && isFloor(a.toFloor)
        AnchorNeeds.ELEVATOR -> isFloor(a.fromFloor) && isFloor(a.toFloor)
        AnchorNeeds.RAMP -> a.direction == "up" || a.direction == "down"
    }

    /** Direction implied by two floors (stairs). */
    fun direction(from: String?, to: String?): String? {
        val a = floorNumber(from) ?: return null
        val b = floorNumber(to) ?: return null
        return if (b > a) "up" else if (b < a) "down" else null
    }

    fun floorNumber(name: String?): Int? = if (!isFloor(name)) null else if (name!!.startsWith("B")) -name.drop(1).toInt() else name.dropLast(1).toInt()

    /** Barometric change since the last vertical anchor that should have been marked (stairs/elevator), metres. */
    const val VERTICAL_REMINDER_M = 3.0
}
