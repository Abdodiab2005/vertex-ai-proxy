import { describe, expect, it, vi } from "vitest";
import { CreditLedgerService } from "./credit-ledger.service.js";
import { EntityManager } from "typeorm";

describe("CreditLedgerService", () => {
  it("maps summary row correctly", async () => {
    const mockQueryBuilder = {
      select: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getRawOne: vi.fn().mockResolvedValue({
        currency: "EUR",
        totalAdded: "100.00",
        totalRemoved: "-10.00",
        totalConsumed: "-5.50",
        totalRefunded: "2.00",
        adjustmentsNet: "1.00",
        remaining: "87.50"
      })
    };

    const mockManager = {
      createQueryBuilder: vi.fn().mockReturnValue(mockQueryBuilder),
    } as unknown as EntityManager;

    const service = new CreditLedgerService();
    const result = await service.summary("key-1", mockManager);

    expect(result).toEqual({
      currency: "EUR",
      totalAdded: "100.00",
      totalRemoved: "-10.00",
      totalConsumed: "-5.50",
      totalRefunded: "2.00",
      adjustmentsNet: "1.00",
      remaining: "87.50"
    });
  });

  it("handles empty summary row by coalescing to 0/USD", async () => {
    const mockQueryBuilder = {
      select: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getRawOne: vi.fn().mockResolvedValue(null) // No transactions yet
    };

    const mockManager = {
      createQueryBuilder: vi.fn().mockReturnValue(mockQueryBuilder),
    } as unknown as EntityManager;

    const service = new CreditLedgerService();
    const result = await service.summary("key-1", mockManager);

    expect(result).toEqual({
      currency: "USD",
      totalAdded: "0",
      totalRemoved: "0",
      totalConsumed: "0",
      totalRefunded: "0",
      adjustmentsNet: "0",
      remaining: "0"
    });
  });
});
