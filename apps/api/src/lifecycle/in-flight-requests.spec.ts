import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayShutdownError, InFlightRequests } from "./in-flight-requests.js";

describe("InFlightRequests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is idle at once when nothing is tracked", async () => {
    await expect(new InFlightRequests().waitUntilIdle(10)).resolves.toBe(true);
  });

  it("resolves when the last tracked request ends", async () => {
    const inFlight = new InFlightRequests();
    const endA = inFlight.track(new AbortController());
    const endB = inFlight.track(new AbortController());

    const idle = inFlight.waitUntilIdle(60_000);
    endA();
    expect(inFlight.size).toBe(1);
    endB();

    await expect(idle).resolves.toBe(true);
  });

  it("gives up after the timeout while requests are still running", async () => {
    vi.useFakeTimers();
    const inFlight = new InFlightRequests();
    inFlight.track(new AbortController());

    const idle = inFlight.waitUntilIdle(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(idle).resolves.toBe(false);
  });

  it("cancels every tracked request with a shutdown reason", () => {
    const inFlight = new InFlightRequests();
    const a = new AbortController();
    const b = new AbortController();
    inFlight.track(a);
    inFlight.track(b);

    inFlight.abortAll();

    expect(a.signal.reason).toBeInstanceOf(GatewayShutdownError);
    expect(b.signal.reason).toBeInstanceOf(GatewayShutdownError);
  });

  it("stays draining once started", () => {
    const inFlight = new InFlightRequests();
    expect(inFlight.draining).toBe(false);
    inFlight.startDraining();
    inFlight.startDraining();
    expect(inFlight.draining).toBe(true);
  });
});
