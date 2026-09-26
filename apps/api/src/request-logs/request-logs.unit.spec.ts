import { describe, it, expect, vi, beforeEach } from "vitest";
import { RequestLogService } from "./request-log.service.js";
import { RequestLogRetentionService } from "./request-log-retention.service.js";
import { RetentionPolicy } from "./retention-policy.js";
import { RequestLogsAdminService } from "./request-logs-admin.service.js";
import { Repository } from "typeorm";
import { RequestLog } from "@gateway/database";
import { ApiKey } from "@gateway/database";

// Mock repository factory
const createMockRepository = () => ({
  insert: vi.fn(),
  query: vi.fn(),
  createQueryBuilder: vi.fn(() => ({
    leftJoin: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    addOrderBy: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    getRawAndEntities: vi.fn().mockResolvedValue({ entities: [], raw: [] }),
    delete: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ affected: 0 }),
  })),
  create: vi.fn().mockImplementation((entity: object) => entity),
});

describe("RequestLogService", () => {
  let service: RequestLogService;
  let mockRepo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    mockRepo = createMockRepository();
    service = new RequestLogService(mockRepo as unknown as Repository<RequestLog>);
  });

  it("records a request log entry", async () => {
    const entry = {
      requestId: "req-123",
      apiKeyId: "key-123",
      model: "gemini-1.5-pro",
      endpoint: "generateContent",
      status: "success",
      latencyMs: 150,
      inputTokens: "100",
      outputTokens: "50",
      otherUsageDimensions: null,
      calculatedCost: "0.0001",
      clientIp: "192.168.1.1",
      userAgent: "test-agent",
      upstream: "upstream-1",
      errorCode: null,
    };

    await service.record(entry);

    expect(mockRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-123",
        apiKeyId: "key-123",
        model: "gemini-1.5-pro",
        endpoint: "generateContent",
        status: "success",
        latencyMs: 150,
        inputTokens: "100",
        outputTokens: "50",
        calculatedCost: "0.0001",
        clientIp: "192.168.1.1",
        userAgent: "test-agent",
        upstream: "upstream-1",
        errorCode: null,
      }),
    );
  });

  it("truncates userAgent to 512 characters", async () => {
    const longAgent = "a".repeat(600);
    const entry = {
      requestId: "req-123",
      apiKeyId: null,
      model: null,
      endpoint: "generateContent",
      status: "success",
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      otherUsageDimensions: null,
      calculatedCost: null,
      clientIp: null,
      userAgent: longAgent,
      upstream: null,
      errorCode: null,
    };

    await service.record(entry);

    expect(mockRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: "a".repeat(512),
      }),
    );
  });

  it("allows null clientIp", async () => {
    const entry = {
      requestId: "req-123",
      apiKeyId: null,
      model: null,
      endpoint: "generateContent",
      status: "success",
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      otherUsageDimensions: null,
      calculatedCost: null,
      clientIp: null,
      userAgent: null,
      upstream: null,
      errorCode: null,
    };

    await service.record(entry);

    expect(mockRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        clientIp: null,
      }),
    );
  });

  it("swallows repository errors and does not throw", async () => {
    mockRepo.insert.mockRejectedValueOnce(new Error("DB connection failed"));

    const entry = {
      requestId: "req-123",
      apiKeyId: null,
      model: null,
      endpoint: "generateContent",
      status: "success",
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      otherUsageDimensions: null,
      calculatedCost: null,
      clientIp: null,
      userAgent: null,
      upstream: null,
      errorCode: null,
    };

    // Should not throw - logging failure must not fail the request
    await expect(service.record(entry)).resolves.toBeUndefined();
  });
});

describe("RequestLogRetentionService", () => {
  let service: RequestLogRetentionService;
  let mockRepo: ReturnType<typeof createMockRepository>;
  let mockPolicy: { getDays: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockRepo = createMockRepository();
    mockPolicy = { getDays: vi.fn().mockReturnValue(90) };
    service = new RequestLogRetentionService(
      mockRepo as unknown as Repository<RequestLog>,
      mockPolicy as unknown as RetentionPolicy,
    );
  });

  it("returns 0 when retention is null (keep forever)", async () => {
    mockPolicy.getDays.mockReturnValue(null);

    const result = await service.purgeOlderThan();

    expect(result).toBe(0);
    expect(mockRepo.query).not.toHaveBeenCalled();
  });

  it("deletes in batches of 5000 and returns total count", async () => {
    mockRepo.query
      .mockResolvedValueOnce([[], 5000])
      .mockResolvedValueOnce([[], 3000]);

    const result = await service.purgeOlderThan();

    expect(result).toBe(8000);
    expect(mockRepo.query).toHaveBeenCalledTimes(2);
  });

  it("stops when deleted less than batch size", async () => {
    mockRepo.query.mockResolvedValueOnce([[], 100]);

    const result = await service.purgeOlderThan();

    expect(result).toBe(100);
    expect(mockRepo.query).toHaveBeenCalledTimes(1);
  });
});

describe("RequestLogsAdminService - cursor encoding/decoding", () => {
  let service: RequestLogsAdminService;
  let mockRequestLogRepo: ReturnType<typeof createMockRepository>;
  let mockApiKeyRepo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    mockRequestLogRepo = createMockRepository();
    mockApiKeyRepo = createMockRepository();
    service = new RequestLogsAdminService(
      mockRequestLogRepo as unknown as Repository<RequestLog>,
      mockApiKeyRepo as unknown as Repository<ApiKey>,
    );
  });

  it("encodes cursor as base64url of ISO|UUID", () => {
    const createdAt = new Date("2024-01-15T10:30:00.000Z");
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    // Test encoding by calling the private method via the service
    const encoded = (service as unknown as { encodeCursor: (createdAt: Date, id: string) => string }).encodeCursor(createdAt, id);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");

    expect(decoded).toBe("2024-01-15T10:30:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("decodes valid cursor", () => {
    const payload = "2024-01-15T10:30:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const cursor = Buffer.from(payload, "utf8").toString("base64url");

    const result = (service as unknown as { decodeCursor: (cursor: string) => { createdAt: Date; id: string } | null }).decodeCursor(cursor);

    expect(result).toEqual({
      createdAt: new Date("2024-01-15T10:30:00.000Z"),
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("returns null for invalid cursor format", () => {
    const svc = service as unknown as { decodeCursor: (cursor: string) => { createdAt: Date; id: string } | null };
    expect(svc.decodeCursor("invalid")).toBeNull();
    expect(svc.decodeCursor("")).toBeNull();
  });

  it("returns null for cursor with invalid date", () => {
    const svc = service as unknown as { decodeCursor: (cursor: string) => { createdAt: Date; id: string } | null };
    const badCursor = Buffer.from("not-a-date|a1b2c3d4-e5f6-7890-abcd-ef1234567890", "utf8").toString("base64url");
    expect(svc.decodeCursor(badCursor)).toBeNull();
  });

  it("returns null for cursor with invalid UUID", () => {
    const svc = service as unknown as { decodeCursor: (cursor: string) => { createdAt: Date; id: string } | null };
    const badCursor = Buffer.from("2024-01-15T10:30:00.000Z|not-a-uuid", "utf8").toString("base64url");
    expect(svc.decodeCursor(badCursor)).toBeNull();
  });
});

describe("RequestLogsAdminService - CSV escaping", () => {
  let service: RequestLogsAdminService;
  let mockRequestLogRepo: ReturnType<typeof createMockRepository>;
  let mockApiKeyRepo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    mockRequestLogRepo = createMockRepository();
    mockApiKeyRepo = createMockRepository();
    service = new RequestLogsAdminService(
      mockRequestLogRepo as unknown as Repository<RequestLog>,
      mockApiKeyRepo as unknown as Repository<ApiKey>,
    );
  });

  const setupMockQb = (entities: unknown[], raw: unknown[]) => {
    const mockQb = {
      leftJoin: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      addOrderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getRawAndEntities: vi.fn().mockResolvedValue({ entities, raw }),
      delete: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue({ affected: 0 }),
    };
    mockRequestLogRepo.createQueryBuilder.mockReturnValue(mockQb);
  };

  it("escapes commas in CSV fields", async () => {
    setupMockQb(
      [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          requestId: "req-1",
          apiKeyId: "key-1",
          model: "gemini-1.5-pro",
          endpoint: "generateContent",
          status: "success",
          latencyMs: 100,
          inputTokens: "100",
          outputTokens: "50",
          otherUsageDimensions: { custom: "value" },
          calculatedCost: "0.001",
          clientIp: "192.168.1.1",
          userAgent: "test-agent",
          upstream: "upstream-1",
          errorCode: null,
          createdAt: new Date("2024-01-15T10:30:00.000Z"),
        },
      ],
      [{ apiKeyName: "Test Key", apiKeyPrefix: "lvg_abc" }],
    );

    const csv = await service.exportRequestLogsCsv({ limit: 50 });

    // The otherUsageDimensions JSON will be escaped (double quotes become double-double-quotes)
    expect(csv).toContain('"{""custom"":""value""}"');
  });

  it("escapes double quotes in CSV fields", async () => {
    setupMockQb(
      [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          requestId: "req-1",
          apiKeyId: "key-1",
          model: 'model"with"quotes',
          endpoint: "generateContent",
          status: "success",
          latencyMs: 100,
          inputTokens: "100",
          outputTokens: "50",
          otherUsageDimensions: null,
          calculatedCost: "0.001",
          clientIp: "192.168.1.1",
          userAgent: "test-agent",
          upstream: "upstream-1",
          errorCode: null,
          createdAt: new Date("2024-01-15T10:30:00.000Z"),
        },
      ],
      [{ apiKeyName: "Test Key", apiKeyPrefix: "lvg_abc" }],
    );

    const csv = await service.exportRequestLogsCsv({ limit: 50 });

    expect(csv).toContain('"model""with""quotes"');
  });

  it("escapes newlines in CSV fields", async () => {
    setupMockQb(
      [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          requestId: "req-1",
          apiKeyId: "key-1",
          model: "model\nwith\nnewlines",
          endpoint: "generateContent",
          status: "success",
          latencyMs: 100,
          inputTokens: "100",
          outputTokens: "50",
          otherUsageDimensions: null,
          calculatedCost: "0.001",
          clientIp: "192.168.1.1",
          userAgent: "test-agent",
          upstream: "upstream-1",
          errorCode: null,
          createdAt: new Date("2024-01-15T10:30:00.000Z"),
        },
      ],
      [{ apiKeyName: "Test Key", apiKeyPrefix: "lvg_abc" }],
    );

    const csv = await service.exportRequestLogsCsv({ limit: 50 });

    // Newlines should be quoted
    expect(csv).toContain('"model\nwith\nnewlines"');
  });

  it("handles null values as empty strings", async () => {
    setupMockQb(
      [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          requestId: "req-1",
          apiKeyId: null,
          model: null,
          endpoint: "generateContent",
          status: "success",
          latencyMs: null,
          inputTokens: null,
          outputTokens: null,
          otherUsageDimensions: null,
          calculatedCost: null,
          clientIp: null,
          userAgent: null,
          upstream: null,
          errorCode: null,
          createdAt: new Date("2024-01-15T10:30:00.000Z"),
        },
      ],
      [{ apiKeyName: null, apiKeyPrefix: null }],
    );

    const csv = await service.exportRequestLogsCsv({ limit: 50 });

    // Should have empty fields for nulls
    const lines = csv.split("\n");
    expect(lines[1]).toContain(",,,,"); // Multiple empty fields
  });

  it("includes header row", async () => {
    setupMockQb(
      [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          requestId: "req-1",
          apiKeyId: "key-1",
          model: "gemini-1.5-pro",
          endpoint: "generateContent",
          status: "success",
          latencyMs: 100,
          inputTokens: "100",
          outputTokens: "50",
          otherUsageDimensions: null,
          calculatedCost: "0.001",
          clientIp: "192.168.1.1",
          userAgent: "test-agent",
          upstream: "upstream-1",
          errorCode: null,
          createdAt: new Date("2024-01-15T10:30:00.000Z"),
        },
      ],
      [{ apiKeyName: "Test Key", apiKeyPrefix: "lvg_abc" }],
    );

    const csv = await service.exportRequestLogsCsv({ limit: 50 });

    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "id,requestId,apiKeyId,apiKeyName,apiKeyPrefix,model,endpoint,status,latencyMs,inputTokens,outputTokens,otherUsageDimensions,calculatedCost,clientIp,userAgent,upstream,errorCode,createdAt",
    );
  });
});