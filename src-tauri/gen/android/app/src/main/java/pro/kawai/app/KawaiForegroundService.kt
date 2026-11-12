package pro.kawai.app

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

/**
 * Holds the process in the *foreground service* state for as long as a run is in
 * flight, so Android never demotes it to the cached state — a cached process is
 * frozen (all threads suspended, TCP sockets torn down), which is what stalled
 * on-device generation and killed the remote tier's streams when the app was
 * minimized. Started and stopped by [KawaiForeground] from the Rust run guard,
 * which is refcounted over every streaming op.
 *
 * `dataSync` is the closest declared type for "the app is working on the user's
 * data right now" and needs no Play declaration; `shortService` is capped at
 * three minutes, which a long generation exceeds.
 */
class KawaiForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = notification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    acquireWakeLock()
    // The service lives exactly as long as the run: never let the system restart
    // it, which would leave a notification for a run that no longer exists.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun notification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_kawai)
      .setContentTitle(getString(R.string.kawai_run_notification_title))
      .setContentText(getString(R.string.kawai_run_notification_text))
      .setContentIntent(open)
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .build()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.kawai_run_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.description = getString(R.string.kawai_run_channel_description)
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  /**
   * With the screen off the CPU is suspended regardless of the process state, so
   * a run would stop making progress even unfrozen. Held for the service's whole
   * lifetime — released in onDestroy, and dropped by the kernel with the process.
   */
  private fun acquireWakeLock() {
    if (wakeLock != null) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseWakeLock() {
    val lock = wakeLock ?: return
    wakeLock = null
    if (lock.isHeld) lock.release()
  }

  private companion object {
    const val CHANNEL_ID = "kawai_run"
    const val NOTIFICATION_ID = 1001
    const val WAKE_LOCK_TAG = "kawai:run"
  }
}
