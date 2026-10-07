package hoshi.campustracker.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoomUploadQueueStoreTest {
    private val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), UploadQueueDatabase::class.java)
        .allowMainThreadQueries().build()
    private val store = RoomUploadQueueStore(db.dao())

    @After fun close() = db.close()

    @Test
    fun queueKeepsOrderStateAndOwners() {
        store.insertSessionIfAbsent(QueueSession("A", "C02", "http://h:3000", "{}", null))
        store.insertSessionIfAbsent(QueueSession("A", "C99", "other", "{}", "ignored")) // existing row wins
        assertEquals("C02", store.session("A")!!.collectorId)
        store.setServerSessionId("A", "srv")
        assertEquals("srv", store.session("A")!!.serverSessionId)

        val b1 = store.insert(QueueItem(kind = ItemKind.batch, itemId = "b1", clientSessionId = "A", payload = "{}"))
        val b2 = store.insert(QueueItem(kind = ItemKind.batch, itemId = "b2", clientSessionId = "A", payload = "{}"))
        store.insert(QueueItem(kind = ItemKind.marker, itemId = "m1", clientSessionId = "A", payload = "{}", needsLocation = true))
        store.insert(QueueItem(kind = ItemKind.batch, itemId = "x", clientSessionId = "B", payload = "{}"))
        assertTrue(b1 < b2)
        assertEquals(listOf("b1", "b2"), store.oldestPending(ItemKind.batch, listOf("A")).map { it.itemId })
        assertEquals(1, store.pendingMarkersNeedingLocation("A").size)
        assertEquals(4, store.countPending(ItemKind.entries))
        assertEquals(1, store.countPendingInSessions(listOf("B")))

        val first = store.oldestPending(ItemKind.batch, listOf("A")).first()
        store.update(first.copy(state = ItemState.QUARANTINED, lastErrorCode = "VALIDATION_ERROR"))
        assertEquals(listOf("b2"), store.oldestPending(ItemKind.batch, listOf("A")).map { it.itemId })
        assertEquals(1, store.countQuarantined())
        store.delete(b2)
        assertEquals(2, store.countItems("A"))

        store.setFinishAcked("A")
        assertTrue(store.session("A")!!.finishAcked)
        store.deleteSession("A")
        assertNull(store.session("A"))
        assertEquals(emptyList<QueueItem>(), store.oldestPending(ItemKind.batch, emptyList()))
    }
}
