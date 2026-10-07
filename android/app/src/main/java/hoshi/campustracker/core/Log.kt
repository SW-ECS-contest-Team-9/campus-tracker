package hoshi.campustracker.core

/** Thin logging facade so JVM unit tests can run without android.util.Log. Never log tokens or raw tracks. */
object L {
    @Volatile var sink: (level: Char, tag: String, message: String, error: Throwable?) -> Unit = { level, tag, message, error ->
        when (level) {
            'E' -> android.util.Log.e(tag, message, error)
            'W' -> android.util.Log.w(tag, message, error)
            'I' -> android.util.Log.i(tag, message)
            else -> android.util.Log.d(tag, message)
        }
    }

    fun d(tag: String, message: String) = sink('D', tag, message, null)
    fun i(tag: String, message: String) = sink('I', tag, message, null)
    fun w(tag: String, message: String, error: Throwable? = null) = sink('W', tag, message, error)
    fun e(tag: String, message: String, error: Throwable? = null) = sink('E', tag, message, error)
}
