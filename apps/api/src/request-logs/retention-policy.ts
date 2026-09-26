import { Injectable } from "@nestjs/common";
import { SettingsService } from "../settings/settings.service.js";

/** How many days request logs are kept, from the logging.metadataRetentionDays setting; null keeps them. */
@Injectable()
export class RetentionPolicy {
  constructor(private readonly settings: SettingsService) {}

  getDays(): Promise<number | null> {
    return this.settings.get("logging.metadataRetentionDays");
  }
}
