package hoshi.campustracker.sync

import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** A version-1 queue (app 1.0) keeps its rows across the upgrade: the queue holds unsent raw data (§6.3). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadQueueMigrationTest {
    @Test
    fun version1QueueMigratesWithoutLosingRows() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val file: File = context.getDatabasePath("migration-test.db").also { it.parentFile!!.mkdirs(); it.delete() }
        // Exactly the version-1 schema (app/schemas/.../1.json).
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            db.execSQL("CREATE TABLE IF NOT EXISTS `queue_sessions` (`clientSessionId` TEXT NOT NULL, `collectorId` TEXT NOT NULL, `serverKey` TEXT NOT NULL, `startPayload` TEXT NOT NULL, `serverSessionId` TEXT, `finishAcked` INTEGER NOT NULL, PRIMARY KEY(`clientSessionId`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `queue_items` (`seq` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, `itemId` TEXT NOT NULL, `clientSessionId` TEXT NOT NULL, `payload` TEXT NOT NULL, `state` TEXT NOT NULL, `lastErrorCode` TEXT, `needsLocation` INTEGER NOT NULL, `sessionRetried` INTEGER NOT NULL)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_queue_items_kind_state` ON `queue_items` (`kind`, `state`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_queue_items_clientSessionId` ON `queue_items` (`clientSessionId`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
            db.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '$V1_HASH')")
            db.execSQL("INSERT INTO queue_sessions VALUES ('A', 'C02', 'http://h:3000', '{}', 'srv', 1)")
            db.execSQL("INSERT INTO queue_items (kind, itemId, clientSessionId, payload, state, lastErrorCode, needsLocation, sessionRetried) VALUES ('batch', 'b1', 'A', '{}', 'pending', NULL, 0, 0)")
            db.version = 1
        }
        val room = Room.databaseBuilder(context, UploadQueueDatabase::class.java, file.absolutePath)
            .addMigrations(UploadQueueDatabase.MIGRATION_1_2).allowMainThreadQueries().build()
        try {
            val store = RoomUploadQueueStore(room.dao())
            val session = store.session("A")!!
            assertEquals("srv", session.serverSessionId)
            assertNull(session.manifest)
            assertNull(session.syncState)
            assertEquals(listOf("b1"), store.oldestPending(ItemKind.batch, listOf("A")).map { it.itemId })
            assertFalse(store.sessions().isEmpty())
        } finally {
            room.close()
        }
    }

    private companion object {
        val V1_HASH: String = File("schemas/hoshi.campustracker.sync.UploadQueueDatabase/1.json").takeIf { it.exists() }?.readText()
            ?.let { Regex("\"identityHash\": \"([0-9a-f]+)\"").find(it)?.groupValues?.get(1) } ?: ""
    }
}
