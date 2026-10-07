package hoshi.campustracker.persistence

import hoshi.campustracker.core.AppJson
import hoshi.campustracker.core.L
import hoshi.campustracker.model.CollectionSession
import hoshi.campustracker.model.IsoMillis
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.MotionSamplingRate
import kotlinx.serialization.Serializable
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Interval statistics for one stream (display only, never uploaded). */
@Serializable
data class GapStats(val count: Int = 0, val maxGapMs: Long = 0) {
    /** A gap is an interval longer than max(3 × expected, 1 s) (§5.6). */
    fun record(previousMs: Long?, currentMs: Long, expectedIntervalMs: Long): GapStats {
        previousMs ?: return this
        val interval = currentMs - previousMs
        val threshold = maxOf(expectedIntervalMs * 3, 1_000L)
        if (interval <= threshold) return this
        return GapStats(count + 1, maxOf(maxGapMs, interval))
    }
}

@Serializable
data class CollectionDiagnostics(
    val foregroundDurationMs: Long = 0,
    val backgroundDurationMs: Long = 0,
    val backgroundTransitionCount: Int = 0,
    val lowPowerModeObserved: Boolean = false,
    val pendingUploadPeakCount: Int = 0,
    val wasInterrupted: Boolean = false,
    val locationGaps: GapStats = GapStats(),
    val motionGaps: GapStats = GapStats(),
    val altimeterGaps: GapStats = GapStats(),
    val pedometerGaps: GapStats = GapStats(),
)

/** `active_collection.json`: what is needed to resume a session after the process died (§6.2). */
@Serializable
data class ActiveCollectionState(
    val session: CollectionSession,
    val motionRate: MotionSamplingRate = MotionSamplingRate.DEFAULT,
    val locationProfile: LocationCollectionProfile = LocationCollectionProfile.DEFAULT,
    val distanceFilter: Double = 0.0,
    val locationSequence: Long = 0,
    val motionSequence: Long = 0,
    val altimeterSequence: Long = 0,
    val pedometerSequence: Long = 0,
    val lastLocationTimestamp: IsoMillis? = null,
    val lastMotionTimestamp: IsoMillis? = null,
    val lastAltimeterTimestamp: IsoMillis? = null,
    val lastPedometerTimestamp: IsoMillis? = null,
    val lastPersistedAt: IsoMillis? = null,
    val diagnostics: CollectionDiagnostics = CollectionDiagnostics(),
    // Android-only: TYPE_STEP_COUNTER continuity across a resume (§4.4)
    val stepBaseline: Long? = null,
    val bootCount: Int? = null,
    val lastStepTotal: Long = 0,
) {
    val lastSampleTimestamp: Long?
        get() = listOfNotNull(lastLocationTimestamp, lastMotionTimestamp, lastAltimeterTimestamp, lastPedometerTimestamp).maxOrNull()
}

interface ActiveCollectionStore {
    fun load(): ActiveCollectionState?
    fun save(state: ActiveCollectionState)
    fun clear()
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written state file. */
class FileActiveCollectionStore(root: File) : ActiveCollectionStore {
    private val file = File(root, "active_collection.json")

    override fun load(): ActiveCollectionState? {
        if (!file.exists()) return null
        return try {
            AppJson.decodeFromString(ActiveCollectionState.serializer(), file.readText())
        } catch (e: Exception) {
            L.e("ActiveStore", "active_collection.json unreadable; keeping file aside", e)
            file.renameTo(File(file.parentFile, "active_collection.corrupt-${System.currentTimeMillis()}.json"))
            null
        }
    }

    @Synchronized
    override fun save(state: ActiveCollectionState) {
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(AppJson.encodeToString(ActiveCollectionState.serializer(), state))
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: IOException) {
            L.e("ActiveStore", "save failed", e)
        }
    }

    @Synchronized
    override fun clear() {
        file.delete()
    }
}
