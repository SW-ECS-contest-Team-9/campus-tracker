package hoshi.campustracker.collection

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import hoshi.campustracker.MainActivity
import hoshi.campustracker.R
import hoshi.campustracker.core.L

/**
 * Foreground service (type `location`) plus a partial wake lock while collecting — the Android counterpart of the
 * iOS background location mode (§5.1). It holds no collection logic: the Application-scoped coordinator does the
 * work, the service only keeps the process and CPU alive. START_NOT_STICKY: a killed process is recovered by the
 * user on next launch, never automatically.
 */
class CollectionService : Service() {
    companion object {
        private const val CHANNEL_ID = "collection"
        private const val NOTIFICATION_ID = 1
        /** Safety cap only; released on Stop. A collection never runs this long. */
        private const val WAKE_LOCK_CAP_MS = 12L * 60 * 60 * 1000

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, CollectionService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CollectionService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CampusTracker 수집 중")
            .setSmallIcon(R.drawable.ic_stat_collecting)
            .setOngoing(true)
            .setContentIntent(open)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
        try {
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } catch (e: Exception) {
            // e.g. ForegroundServiceStartNotAllowedException / missing location permission.
            L.e("CollectionService", "startForeground failed", e)
            stopSelf()
            return START_NOT_STICKY
        }
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CampusTracker:collection")
                .apply { setReferenceCounted(false); acquire(WAKE_LOCK_CAP_MS) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Collection", NotificationManager.IMPORTANCE_LOW))
        }
    }
}
