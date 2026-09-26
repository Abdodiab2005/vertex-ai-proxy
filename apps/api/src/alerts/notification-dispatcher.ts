import { Inject, Injectable, Logger } from "@nestjs/common";
import { NotificationChannel, AdminPanelChannel } from "./notification-channel.js";
import { AlertView } from "@gateway/contracts";

/** Multi-provider token for registering additional notification channels */
export const NOTIFICATION_CHANNELS_TOKEN = "NOTIFICATION_CHANNELS";

/**
 * Dispatches alerts to all registered notification channels.
 * Each channel's errors are isolated - one failing channel never blocks
 * the others or the evaluator.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly channels: NotificationChannel[];

  constructor(
    @Inject(NOTIFICATION_CHANNELS_TOKEN) private readonly extraChannels: NotificationChannel[],
  ) {
    // AdminPanelChannel is always registered as the first channel
    this.channels = [new AdminPanelChannel(), ...extraChannels];
  }

  /**
   * Dispatch an alert to all registered channels.
   * Errors in individual channels are logged but don't propagate.
   */
  async dispatch(alert: AlertView): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.send(alert);
        } catch (error) {
          this.logger.error(
            `Notification channel "${channel.name}" failed to send alert ${alert.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }),
    );
  }
}