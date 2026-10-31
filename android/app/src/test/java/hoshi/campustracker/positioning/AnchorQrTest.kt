package hoshi.campustracker.positioning

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnchorQrTest {
    @Test fun acceptsOnlyTheCanonicalAnchorFormat() {
        val id = "618ca240-2c9a-430d-a1f9-30a040c070d0"
        assertEquals(id, parseAnchorQr("campustracker:node:${id.uppercase()}"))
        assertNull(parseAnchorQr("campustracker:node:1-1-1-1-1"))
        assertNull(parseAnchorQr("https://example.com/$id"))
        assertNull(parseAnchorQr("campustracker:node:$id?x=1"))
    }
}
