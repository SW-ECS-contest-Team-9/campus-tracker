package hoshi.campustracker.persistence

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.core.L
import hoshi.campustracker.model.PlannedRoute
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** `saved_routes.json`: declared routes the collector saved by name, on this phone only. Same atomic write as the state file. */
class SavedRoutesStore(root: File) {
    private val file = File(root, "saved_routes.json")
    private val serializer = ListSerializer(PlannedRoute.serializer())

    @Synchronized
    fun load(): List<PlannedRoute> {
        if (!file.exists()) return emptyList()
        return try {
            AppJson.decodeFromString(serializer, file.readText())
        } catch (e: Exception) {
            L.e("SavedRoutes", "saved_routes.json unreadable; keeping file aside", e)
            file.renameTo(File(file.parentFile, "saved_routes.corrupt-${System.currentTimeMillis()}.json"))
            emptyList()
        }
    }

    /** Saves [route] under its name (trimmed, required); a route of the same name is replaced. Returns the new list. */
    @Synchronized
    fun save(route: PlannedRoute): List<PlannedRoute> {
        val name = route.name?.trim().orEmpty()
        require(name.isNotEmpty()) { "a saved route needs a name" }
        val routes = load().filterNot { it.name == name } + route.copy(name = name)
        write(routes)
        return routes
    }

    @Synchronized
    fun delete(name: String): List<PlannedRoute> {
        val routes = load().filterNot { it.name == name }
        write(routes)
        return routes
    }

    private fun write(routes: List<PlannedRoute>) {
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(AppJson.encodeToString(serializer, routes))
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: IOException) {
            L.e("SavedRoutes", "save failed", e)
        }
    }
}
