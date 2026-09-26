import { AlertView } from "@gateway/contracts";

/**
 * Notification channel interface.
 * Implementations can send alerts via email, Telegram, webhooks, etc.
 * The AdminPanelChannel is a no-op because the alerts table IS the admin panel's feed.
 */
export interface NotificationChannel {
  /** Unique name for this channel */
  readonly name: string;

  /**
   * Send an alert notification.
   * @param alert The alert to notify about
   * @throws Errors are caught by the dispatcher and logged, but don't block other channels
   */
  send(alert: AlertView): Promise<void>;
}

/**
 * The admin panel channel is a no-op send because the alerts table
 * IS the admin panel's feed. The admin UI polls /admin/alerts to show alerts.
 * This channel exists to satisfy the notification abstraction and allow
 * the dispatcher to track that the admin panel is a "channel".
 */
export class AdminPanelChannel implements NotificationChannel {
  readonly name = "admin-panel";

  async send(_alert: AlertView): Promise<void> {
    // No-op: the alerts table is the admin panel's feed
    // The admin UI fetches alerts via GET /admin/alerts
  }
}