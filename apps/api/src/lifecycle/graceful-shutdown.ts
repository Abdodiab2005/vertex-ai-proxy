import { BeforeApplicationShutdown, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "../config/config.service.js";
import { InFlightRequests } from "./in-flight-requests.js";

/** How long cancelled requests get to write their usage and release their holds. */
const SETTLE_AFTER_CANCEL_MS = 5_000;

/**
 * Runs after a termination signal and before Nest closes the HTTP server, which destroys open
 * sockets. New public requests are already refused (and readiness fails) from the moment draining
 * starts; requests in flight get SHUTDOWN_GRACE_MS to finish, then are cancelled so that streams
 * settle what they used instead of vanishing unbilled with their slot and reservation held.
 */
@Injectable()
export class GracefulShutdown implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdown.name);

  constructor(
    private readonly inFlight: InFlightRequests,
    private readonly config: ConfigService,
  ) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.inFlight.startDraining();
    const graceMs = this.config.env.SHUTDOWN_GRACE_MS;
    this.logger.log(`Shutting down (${signal ?? "close"}): draining ${this.inFlight.size} request(s)`);

    if (await this.inFlight.waitUntilIdle(graceMs)) {
      return;
    }

    this.logger.warn(`${this.inFlight.size} request(s) still running after ${graceMs} ms; cancelling them`);
    this.inFlight.abortAll();
    if (!(await this.inFlight.waitUntilIdle(SETTLE_AFTER_CANCEL_MS))) {
      this.logger.error(`${this.inFlight.size} request(s) did not settle; their leases expire on their own`);
    }
  }
}
