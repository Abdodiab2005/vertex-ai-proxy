import { ServiceUnavailableException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { getDataSourceToken } from "@nestjs/typeorm";
import { AppController } from "./app.controller.js";
import { RedisService } from "./redis/redis.service.js";
import { InFlightRequests } from "./lifecycle/in-flight-requests.js";

describe("AppController", () => {
  let controller: AppController;
  let inFlight: InFlightRequests;
  const mockDataSource = { query: vi.fn() };
  const mockRedis = { ping: vi.fn() };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: RedisService, useValue: mockRedis },
        InFlightRequests,
      ],
    }).compile();

    controller = moduleRef.get(AppController);
    inFlight = moduleRef.get(InFlightRequests);
    vi.clearAllMocks();
  });

  it("reports ok when both database and redis are reachable", async () => {
    mockDataSource.query.mockResolvedValue([{ "?column?": 1 }]);
    mockRedis.ping.mockResolvedValue("PONG");

    await expect(controller.getHealth()).resolves.toEqual({
      status: "ok",
      database: "connected",
      redis: "connected",
    });
  });

  it("throws when the database is unreachable", async () => {
    mockDataSource.query.mockRejectedValue(new Error("connection refused"));
    mockRedis.ping.mockResolvedValue("PONG");

    await expect(controller.getHealth()).rejects.toThrow();
  });

  it("throws when redis is unreachable", async () => {
    mockDataSource.query.mockResolvedValue([{ "?column?": 1 }]);
    mockRedis.ping.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(controller.getHealth()).rejects.toThrow();
  });

  it("fails readiness while draining for shutdown, with healthy dependencies", async () => {
    mockDataSource.query.mockResolvedValue([{ "?column?": 1 }]);
    mockRedis.ping.mockResolvedValue("PONG");
    inFlight.startDraining();

    await expect(controller.getReadiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("reports ready when both dependencies are available", async () => {
    mockDataSource.query.mockResolvedValue([{ "?column?": 1 }]);
    mockRedis.ping.mockResolvedValue("PONG");

    await expect(controller.getReadiness()).resolves.toEqual({
      status: "ready",
      checks: {
        database: "ok",
        redis: "ok",
      },
    });
  });

  it.each([
    {
      name: "database",
      configureFailure: () => {
        mockDataSource.query.mockRejectedValue(new Error("connection refused"));
        mockRedis.ping.mockResolvedValue("PONG");
      },
      checks: { database: "unavailable", redis: "ok" },
    },
    {
      name: "redis",
      configureFailure: () => {
        mockDataSource.query.mockResolvedValue([{ "?column?": 1 }]);
        mockRedis.ping.mockRejectedValue(new Error("ECONNREFUSED"));
      },
      checks: { database: "ok", redis: "unavailable" },
    },
  ])("reports %s as unavailable when readiness fails", async ({ configureFailure, checks }) => {
    configureFailure();

    try {
      await controller.getReadiness();
      throw new Error("Expected readiness to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      if (error instanceof ServiceUnavailableException) {
        expect(error.getStatus()).toBe(503);
        expect(error.getResponse()).toEqual({ status: "not_ready", checks });
      }
    }
  });

  it("reports liveness without checking database or redis", () => {
    expect(controller.getLiveness()).toEqual({ status: "alive" });
    expect(mockDataSource.query).not.toHaveBeenCalled();
    expect(mockRedis.ping).not.toHaveBeenCalled();
  });
});
