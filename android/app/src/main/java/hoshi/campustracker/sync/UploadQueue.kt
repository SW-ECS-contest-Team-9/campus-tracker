package hoshi.campustracker.sync

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update

enum class ItemKind(val wireType: String) {
    batch("telemetry:batch"), marker("marker:create"), finish("session:finish"), diagnostic("diagnostic:event")
}

object ItemState {
    const val PENDING = "pending"
    const val QUARANTINED = "quarantined"
}

/** One session known to the queue, with its owner (collector + server) at start time (§12-6). */
data class QueueSession(
    val clientSessionId: String,
    val collectorId: String,
    val serverKey: String,
    val startPayload: String,
    val serverSessionId: String?,
    val finishAcked: Boolean = false,
)

data class QueueItem(
    val seq: Long = 0,
    val kind: ItemKind,
    /** batchId, markerId, clientSessionId (finish) or eventId: the server's dedupe key, reused on every retry. */
    val itemId: String,
    val clientSessionId: String,
    val payload: String,
    val state: String = ItemState.PENDING,
    val lastErrorCode: String? = null,
    /** Marker recorded before this process had any fix (§12-5). */
    val needsLocation: Boolean = false,
    /** SESSION_NOT_FOUND / SESSION_NOT_STARTED already triggered one session:start re-handshake (§12-3). */
    val sessionRetried: Boolean = false,
)

/** Persistent upload queue (iOS `PersistentUploadQueue`), one row per item. Called from the sync thread only. */
interface UploadQueueStore {
    fun sessions(): List<QueueSession>
    fun session(clientSessionId: String): QueueSession?
    fun insertSessionIfAbsent(session: QueueSession)
    fun setServerSessionId(clientSessionId: String, serverSessionId: String?)
    fun setFinishAcked(clientSessionId: String)
    fun deleteSession(clientSessionId: String)

    fun insert(item: QueueItem): Long
    fun update(item: QueueItem)
    fun delete(seq: Long)
    /** Pending items of [kind] in [sessionIds], oldest first. */
    fun oldestPending(kind: ItemKind, sessionIds: Collection<String>, limit: Int = 50): List<QueueItem>
    fun pendingMarkersNeedingLocation(clientSessionId: String): List<QueueItem>
    fun countItems(clientSessionId: String): Int
    fun countPending(kinds: Collection<ItemKind>): Int
    fun countPendingInSessions(sessionIds: Collection<String>): Int
    fun countQuarantined(): Int
}

@Entity(tableName = "queue_sessions")
data class QueueSessionEntity(
    @PrimaryKey val clientSessionId: String,
    val collectorId: String,
    val serverKey: String,
    val startPayload: String,
    val serverSessionId: String?,
    val finishAcked: Boolean,
)

@Entity(tableName = "queue_items", indices = [Index("kind", "state"), Index("clientSessionId")])
data class QueueItemEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val kind: String,
    val itemId: String,
    val clientSessionId: String,
    val payload: String,
    val state: String,
    val lastErrorCode: String?,
    val needsLocation: Boolean,
    val sessionRetried: Boolean,
)

@Dao
interface QueueDao {
    @Query("SELECT * FROM queue_sessions ORDER BY rowid")
    fun sessions(): List<QueueSessionEntity>

    @Query("SELECT * FROM queue_sessions WHERE clientSessionId = :id")
    fun session(id: String): QueueSessionEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertSession(session: QueueSessionEntity)

    @Query("UPDATE queue_sessions SET serverSessionId = :serverId WHERE clientSessionId = :id")
    fun setServerSessionId(id: String, serverId: String?)

    @Query("UPDATE queue_sessions SET finishAcked = 1 WHERE clientSessionId = :id")
    fun setFinishAcked(id: String)

    @Query("DELETE FROM queue_sessions WHERE clientSessionId = :id")
    fun deleteSession(id: String)

    @Insert
    fun insert(item: QueueItemEntity): Long

    @Update
    fun update(item: QueueItemEntity)

    @Query("DELETE FROM queue_items WHERE seq = :seq")
    fun delete(seq: Long)

    @Query("SELECT * FROM queue_items WHERE kind = :kind AND state = 'pending' AND clientSessionId IN (:ids) ORDER BY seq LIMIT :limit")
    fun oldestPending(kind: String, ids: List<String>, limit: Int): List<QueueItemEntity>

    @Query("SELECT * FROM queue_items WHERE kind = 'marker' AND state = 'pending' AND needsLocation = 1 AND clientSessionId = :id ORDER BY seq")
    fun pendingMarkersNeedingLocation(id: String): List<QueueItemEntity>

    @Query("SELECT COUNT(*) FROM queue_items WHERE clientSessionId = :id")
    fun countItems(id: String): Int

    @Query("SELECT COUNT(*) FROM queue_items WHERE state = 'pending' AND kind IN (:kinds)")
    fun countPending(kinds: List<String>): Int

    @Query("SELECT COUNT(*) FROM queue_items WHERE state = 'pending' AND clientSessionId IN (:ids)")
    fun countPendingInSessions(ids: List<String>): Int

    @Query("SELECT COUNT(*) FROM queue_items WHERE state = 'quarantined'")
    fun countQuarantined(): Int
}

/**
 * Schema changes must ship a Room migration (never destructive fallback): the queue holds unsent raw data (§6.3).
 * Exported schemas live in `app/schemas/`.
 */
@Database(entities = [QueueSessionEntity::class, QueueItemEntity::class], version = 1, exportSchema = true)
abstract class UploadQueueDatabase : RoomDatabase() {
    abstract fun dao(): QueueDao

    companion object {
        fun open(context: Context): UploadQueueDatabase =
            Room.databaseBuilder(context, UploadQueueDatabase::class.java, "upload_queue.db")
                // .addMigrations(...) — add every future migration here.
                .build()
    }
}

class RoomUploadQueueStore(private val dao: QueueDao) : UploadQueueStore {
    override fun sessions() = dao.sessions().map { it.toModel() }
    override fun session(clientSessionId: String) = dao.session(clientSessionId)?.toModel()
    override fun insertSessionIfAbsent(session: QueueSession) = dao.insertSession(
        QueueSessionEntity(session.clientSessionId, session.collectorId, session.serverKey, session.startPayload, session.serverSessionId, session.finishAcked),
    )
    override fun setServerSessionId(clientSessionId: String, serverSessionId: String?) = dao.setServerSessionId(clientSessionId, serverSessionId)
    override fun setFinishAcked(clientSessionId: String) = dao.setFinishAcked(clientSessionId)
    override fun deleteSession(clientSessionId: String) = dao.deleteSession(clientSessionId)
    override fun insert(item: QueueItem): Long = dao.insert(item.toEntity())
    override fun update(item: QueueItem) = dao.update(item.toEntity())
    override fun delete(seq: Long) = dao.delete(seq)
    override fun oldestPending(kind: ItemKind, sessionIds: Collection<String>, limit: Int): List<QueueItem> =
        if (sessionIds.isEmpty()) emptyList() else dao.oldestPending(kind.name, sessionIds.toList(), limit).mapNotNull { it.toModel() }
    override fun pendingMarkersNeedingLocation(clientSessionId: String) = dao.pendingMarkersNeedingLocation(clientSessionId).mapNotNull { it.toModel() }
    override fun countItems(clientSessionId: String) = dao.countItems(clientSessionId)
    override fun countPending(kinds: Collection<ItemKind>) = dao.countPending(kinds.map { it.name })
    override fun countPendingInSessions(sessionIds: Collection<String>) =
        if (sessionIds.isEmpty()) 0 else dao.countPendingInSessions(sessionIds.toList())
    override fun countQuarantined() = dao.countQuarantined()

    private fun QueueSessionEntity.toModel() = QueueSession(clientSessionId, collectorId, serverKey, startPayload, serverSessionId, finishAcked)
    private fun QueueItemEntity.toModel(): QueueItem? {
        val k = ItemKind.entries.firstOrNull { it.name == kind } ?: return null
        return QueueItem(seq, k, itemId, clientSessionId, payload, state, lastErrorCode, needsLocation, sessionRetried)
    }
    private fun QueueItem.toEntity() = QueueItemEntity(seq, kind.name, itemId, clientSessionId, payload, state, lastErrorCode, needsLocation, sessionRetried)
}

/** In-memory store with the same semantics (unit tests). */
class InMemoryUploadQueueStore : UploadQueueStore {
    private val sessions = linkedMapOf<String, QueueSession>()
    private val items = sortedMapOf<Long, QueueItem>()
    private var nextSeq = 1L

    override fun sessions() = sessions.values.toList()
    override fun session(clientSessionId: String) = sessions[clientSessionId]
    override fun insertSessionIfAbsent(session: QueueSession) {
        sessions.putIfAbsent(session.clientSessionId, session)
    }
    override fun setServerSessionId(clientSessionId: String, serverSessionId: String?) {
        sessions[clientSessionId]?.let { sessions[clientSessionId] = it.copy(serverSessionId = serverSessionId) }
    }
    override fun setFinishAcked(clientSessionId: String) {
        sessions[clientSessionId]?.let { sessions[clientSessionId] = it.copy(finishAcked = true) }
    }
    override fun deleteSession(clientSessionId: String) {
        sessions.remove(clientSessionId)
    }
    override fun insert(item: QueueItem): Long {
        val seq = nextSeq++
        items[seq] = item.copy(seq = seq)
        return seq
    }
    override fun update(item: QueueItem) {
        if (items.containsKey(item.seq)) items[item.seq] = item
    }
    override fun delete(seq: Long) {
        items.remove(seq)
    }
    override fun oldestPending(kind: ItemKind, sessionIds: Collection<String>, limit: Int) =
        items.values.filter { it.kind == kind && it.state == ItemState.PENDING && it.clientSessionId in sessionIds }.take(limit)
    override fun pendingMarkersNeedingLocation(clientSessionId: String) =
        items.values.filter { it.kind == ItemKind.marker && it.state == ItemState.PENDING && it.needsLocation && it.clientSessionId == clientSessionId }
    override fun countItems(clientSessionId: String) = items.values.count { it.clientSessionId == clientSessionId }
    override fun countPending(kinds: Collection<ItemKind>) = items.values.count { it.state == ItemState.PENDING && it.kind in kinds }
    override fun countPendingInSessions(sessionIds: Collection<String>) = items.values.count { it.state == ItemState.PENDING && it.clientSessionId in sessionIds }
    override fun countQuarantined() = items.values.count { it.state == ItemState.QUARANTINED }

    fun allItems(): List<QueueItem> = items.values.toList()
}
