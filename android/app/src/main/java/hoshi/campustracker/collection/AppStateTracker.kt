package hoshi.campustracker.collection

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import hoshi.campustracker.model.CollectorAppState

/**
 * Process-level app state from ProcessLifecycleOwner: RESUMED → FOREGROUND, STARTED → INACTIVE, below → BACKGROUND.
 * Written on the main thread, read by the collection thread for every sample.
 */
class AppStateTracker(private val onChange: (CollectorAppState) -> Unit) : DefaultLifecycleObserver {
    @Volatile var current: CollectorAppState = CollectorAppState.BACKGROUND
        private set

    fun install() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    private fun set(state: CollectorAppState) {
        if (state == current) return
        current = state
        onChange(state)
    }

    override fun onStart(owner: LifecycleOwner) = set(CollectorAppState.INACTIVE)
    override fun onResume(owner: LifecycleOwner) = set(CollectorAppState.FOREGROUND)
    override fun onPause(owner: LifecycleOwner) = set(CollectorAppState.INACTIVE)
    override fun onStop(owner: LifecycleOwner) = set(CollectorAppState.BACKGROUND)
}
