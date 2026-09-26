import { Injectable } from "@nestjs/common";

/** The abort reason for requests the gateway cancels itself while shutting down. */
export class GatewayShutdownError extends Error {
  constructor() {
    super("The gateway is restarting.");
    this.name = "GatewayShutdownError";
  }
}

/**
 * Public requests currently being served, so a shutdown can wait for them (and settle their
 * billing) before the HTTP server closes their sockets.
 */
@Injectable()
export class InFlightRequests {
  private readonly active = new Set<AbortController>();
  private idleWaiters: (() => void)[] = [];
  private drainingSince: number | null = null;

  get draining(): boolean {
    return this.drainingSince !== null;
  }

  get size(): number {
    return this.active.size;
  }

  /** Returns the function that ends tracking; call it once the request has fully settled. */
  track(controller: AbortController): () => void {
    this.active.add(controller);
    return () => {
      this.active.delete(controller);
      if (this.active.size === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  startDraining(): void {
    this.drainingSince ??= Date.now();
  }

  /** Resolves true once nothing is in flight, or false when the timeout passes first. */
  waitUntilIdle(timeoutMs: number): Promise<boolean> {
    if (this.active.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== onIdle);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.push(onIdle);
    });
  }

  abortAll(): void {
    for (const controller of this.active) {
      controller.abort(new GatewayShutdownError());
    }
  }
}
