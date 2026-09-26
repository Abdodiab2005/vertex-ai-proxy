import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import { NotificationChannel, AdminPanelChannel } from "../notification-channel.js";
import { AlertView } from "@gateway/contracts";
import { Logger } from "@nestjs/common";

describe("NotificationDispatcher", () => {
  let dispatcher: NotificationDispatcher;
  let mockChannel1: NotificationChannel;
  let mockChannel2: NotificationChannel;
  let failingChannel: NotificationChannel;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    loggerErrorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    mockChannel1 = {
      name: "channel-1",
      send: vi.fn().mockResolvedValue(undefined),
    };

    mockChannel2 = {
      name: "channel-2",
      send: vi.fn().mockResolvedValue(undefined),
    };

    failingChannel = {
      name: "failing-channel",
      send: vi.fn().mockRejectedValue(new Error("Channel failed")),
    };
  });

  const makeAlert = (overrides: Partial<AlertView> = {}): AlertView => ({
    id: "alert-1",
    type: "credit_80",
    severity: "warning",
    dedupeKey: "credit_80:key-1",
    title: "Credit usage at 80%",
    message: "API key has consumed 80% of its available credit",
    data: { apiKeyId: "key-1" },
    status: "active",
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    acknowledgedAt: null,
    acknowledgedByAdminId: null,
    acknowledgedByAdminEmail: null,
    resolvedAt: null,
    ...overrides,
  });

  it("dispatches to all registered channels", async () => {
    dispatcher = new NotificationDispatcher([mockChannel1, mockChannel2]);
    const alert = makeAlert();
    await dispatcher.dispatch(alert);
    expect(mockChannel1.send).toHaveBeenCalledWith(alert);
    expect(mockChannel2.send).toHaveBeenCalledWith(alert);
  });

  it("includes AdminPanelChannel as first channel by default", async () => {
    dispatcher = new NotificationDispatcher([]);
    const alert = makeAlert();
    await dispatcher.dispatch(alert);
    // AdminPanelChannel is a no-op, but we can verify it doesn't throw
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it("isolates errors - one failing channel does not block others", async () => {
    dispatcher = new NotificationDispatcher([mockChannel1, failingChannel, mockChannel2]);
    const alert = makeAlert();
    await dispatcher.dispatch(alert);
    expect(mockChannel1.send).toHaveBeenCalledWith(alert);
    expect(failingChannel.send).toHaveBeenCalledWith(alert);
    expect(mockChannel2.send).toHaveBeenCalledWith(alert);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Notification channel "failing-channel" failed'),
      expect.any(String),
    );
  });

  it("continues dispatching even if first channel fails", async () => {
    const failingFirst = {
      name: "failing-first",
      send: vi.fn().mockRejectedValue(new Error("First failed")),
    };
    dispatcher = new NotificationDispatcher([failingFirst, mockChannel2]);
    const alert = makeAlert();
    await dispatcher.dispatch(alert);
    expect(failingFirst.send).toHaveBeenCalledWith(alert);
    expect(mockChannel2.send).toHaveBeenCalledWith(alert);
    expect(loggerErrorSpy).toHaveBeenCalled();
  });

  it("continues dispatching even if last channel fails", async () => {
    const failingLast = {
      name: "failing-last",
      send: vi.fn().mockRejectedValue(new Error("Last failed")),
    };
    dispatcher = new NotificationDispatcher([mockChannel1, failingLast]);
    const alert = makeAlert();
    await dispatcher.dispatch(alert);
    expect(mockChannel1.send).toHaveBeenCalledWith(alert);
    expect(failingLast.send).toHaveBeenCalledWith(alert);
    expect(loggerErrorSpy).toHaveBeenCalled();
  });

  it("handles all channels failing", async () => {
    const failing1 = {
      name: "fail-1",
      send: vi.fn().mockRejectedValue(new Error("Fail 1")),
    };
    const failing2 = {
      name: "fail-2",
      send: vi.fn().mockRejectedValue(new Error("Fail 2")),
    };
    dispatcher = new NotificationDispatcher([failing1, failing2]);
    const alert = makeAlert();
    await dispatcher.dispatch(alert);
    expect(failing1.send).toHaveBeenCalledWith(alert);
    expect(failing2.send).toHaveBeenCalledWith(alert);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("works with no extra channels (only AdminPanelChannel)", async () => {
    dispatcher = new NotificationDispatcher([]);
    const alert = makeAlert();
    await expect(dispatcher.dispatch(alert)).resolves.not.toThrow();
  });
});

describe("AdminPanelChannel", () => {
  it("is a no-op send", async () => {
    const channel = new AdminPanelChannel();
    const alert: AlertView = {
      id: "alert-1",
      type: "credit_80",
      severity: "warning",
      dedupeKey: "credit_80:key-1",
      title: "Test",
      message: "Test",
      data: {},
      status: "active",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      acknowledgedAt: null,
      acknowledgedByAdminId: null,
      acknowledgedByAdminEmail: null,
      resolvedAt: null,
    };
    await expect(channel.send(alert)).resolves.not.toThrow();
    expect(channel.name).toBe("admin-panel");
  });
});