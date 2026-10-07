package hoshi.campustracker.persistence

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.core.L
import hoshi.campustracker.model.CollectionSession
import hoshi.campustracker.sync.AltimeterPayload
import hoshi.campustracker.sync.LocationPayload
import hoshi.campustracker.sync.MarkerPayload
import hoshi.campustracker.sync.MotionPayload
import hoshi.campustracker.sync.PedometerPayload
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

interface SensorDataRepository {
    fun create(session: CollectionSession)
    fun update(session: CollectionSession)
    /** Keeps the in-memory session (counts) current; written with the next flush. */
    fun track(session: CollectionSession)
    fun appendLocation(sample: LocationPayload)
    fun appendMotion(sample: MotionPayload)
    fun appendAltimeter(sample: AltimeterPayload)
    fun appendPedometer(sample: PedometerPayload)
    fun appendMarker(marker: MarkerPayload)
    /** Flushes when a buffer reached 32 lines or 2 s passed since the last flush. */
    fun flushIfDue(nowMs: Long)
    fun flush()
    fun loadSessions(): List<CollectionSession>
}

/**
 * Local-first raw store (iOS `LocalSensorDataRepository`): `sessions/<clientSessionId>/` with `metadata.json` and one
 * NDJSON file per stream. Lines are the converted wire DTOs with millisecond timestamps. Single-threaded by contract
 * (the collection thread); [loadSessions] only reads metadata files.
 */
class LocalSensorDataRepository(
    root: File,
    private val nowMs: () -> Long,
) : SensorDataRepository {
    private val sessionsDir = File(root, "sessions")
    private var session: CollectionSession? = null
    private val buffers = linkedMapOf(
        "location" to StringBuilder(), "motion" to StringBuilder(), "altimeter" to StringBuilder(),
        "pedometer" to StringBuilder(), "marker" to StringBuilder(),
    )
    private val bufferedLines = mutableMapOf<String, Int>()
    private var lastFlushMs = 0L

    private fun dir(id: String) = File(sessionsDir, id)

    override fun create(session: CollectionSession) {
        this.session = session
        dir(session.id).mkdirs()
        lastFlushMs = nowMs()
        writeMetadata(session)
    }

    override fun update(session: CollectionSession) {
        if (this.session?.id != session.id) flush()
        this.session = session
        dir(session.id).mkdirs()
        writeMetadata(session)
    }

    override fun appendLocation(sample: LocationPayload) = append("location", AppJson.encodeToString(LocationPayload.serializer(), sample))
    override fun appendMotion(sample: MotionPayload) = append("motion", AppJson.encodeToString(MotionPayload.serializer(), sample))
    override fun appendAltimeter(sample: AltimeterPayload) = append("altimeter", AppJson.encodeToString(AltimeterPayload.serializer(), sample))
    override fun appendPedometer(sample: PedometerPayload) = append("pedometer", AppJson.encodeToString(PedometerPayload.serializer(), sample))
    override fun appendMarker(marker: MarkerPayload) = append("marker", AppJson.encodeToString(MarkerPayload.serializer(), marker))

    private fun append(stream: String, line: String) {
        val buffer = buffers.getValue(stream)
        buffer.append(line).append('\n')
        val count = (bufferedLines[stream] ?: 0) + 1
        bufferedLines[stream] = count
        if (count >= 32) flush() else flushIfDue(nowMs())
    }

    override fun flushIfDue(nowMs: Long) {
        if (nowMs - lastFlushMs >= 2_000) flush()
    }

    override fun flush() {
        val current = session ?: return
        lastFlushMs = nowMs()
        val directory = dir(current.id)
        directory.mkdirs()
        for ((stream, buffer) in buffers) {
            if (buffer.isEmpty()) continue
            try {
                File(directory, "$stream.ndjson").appendText(buffer.toString())
            } catch (e: IOException) {
                L.e("Repository", "append failed stream=$stream", e)
                continue
            }
            buffer.setLength(0)
            bufferedLines[stream] = 0
        }
        writeMetadata(current)
    }

    override fun track(session: CollectionSession) {
        this.session = session
    }

    private fun writeMetadata(session: CollectionSession) {
        try {
            val directory = dir(session.id)
            val tmp = File(directory, "metadata.json.tmp")
            tmp.writeText(AppJson.encodeToString(CollectionSession.serializer(), session))
            Files.move(tmp.toPath(), File(directory, "metadata.json").toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: IOException) {
            L.e("Repository", "metadata write failed", e)
        }
    }

    override fun loadSessions(): List<CollectionSession> {
        val dirs = sessionsDir.listFiles()?.filter { it.isDirectory } ?: return emptyList()
        return dirs.mapNotNull { d ->
            val file = File(d, "metadata.json")
            if (!file.exists()) return@mapNotNull null
            try {
                AppJson.decodeFromString(CollectionSession.serializer(), file.readText())
            } catch (e: Exception) {
                L.w("Repository", "unreadable metadata ${d.name}", e)
                null
            }
        }.sortedByDescending { it.startedAt }
    }
}
