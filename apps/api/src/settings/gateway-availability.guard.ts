import { HttpStatus, Injectable } from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import { GeminiApiException } from "../public-api/gemini-errors.js";
import { SettingsService } from "./settings.service.js";

@Injectable()
export class GatewayAvailabilityGuard implements CanActivate {
  constructor(private readonly settings: SettingsService) {}

  async canActivate(): Promise<boolean> {
    const snapshot = await this.settings.getAll();

    if (snapshot["gateway.killSwitch"]) {
      throw new GeminiApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "UNAVAILABLE",
        "The gateway is temporarily disabled.",
      );
    }
    if (!snapshot["gateway.enabled"]) {
      throw new GeminiApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "UNAVAILABLE",
        "The gateway is disabled.",
      );
    }
    if (snapshot["gateway.maintenanceMode"]) {
      throw new GeminiApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "UNAVAILABLE",
        snapshot["gateway.maintenanceMessage"],
      );
    }
    return true;
  }
}
