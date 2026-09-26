import { describe, expect, it, vi } from "vitest";
import { CreditReservationStore } from "./credit-reservation.store.js";
import { RedisService } from "../redis/redis.service.js";

describe("CreditReservationStore", () => {
  it("parses Lua reserve result correctly when allowed", async () => {
    const mockRedis = {
      client: {
        time: vi.fn().mockResolvedValue(["1000", "500000"]),
        eval: vi.fn().mockResolvedValue([1, "30000"]),
      }
    } as unknown as RedisService;

    const store = new CreditReservationStore(mockRedis);
    const result = await store.reserve("key-1", 100000n, 30000n, 5000);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.reservedMicros).toBe(30000n);
      expect(typeof result.reservationId).toBe("string");
    }
  });

  it("parses Lua reserve result correctly when denied", async () => {
    const mockRedis = {
      client: {
        time: vi.fn().mockResolvedValue(["1000", "500000"]),
        eval: vi.fn().mockResolvedValue([0, "0"]),
      }
    } as unknown as RedisService;

    const store = new CreditReservationStore(mockRedis);
    const result = await store.reserve("key-1", 0n, 30000n, 5000);

    expect(result.allowed).toBe(false);
  });
});
