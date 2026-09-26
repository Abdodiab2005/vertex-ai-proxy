import { ApiKeyStatus, CreditTransactionType } from "./enums";

describe("enums", () => {
  it("ApiKeyStatus has exactly the five key lifecycle states", () => {
    expect(Object.values(ApiKeyStatus).sort()).toEqual(
      ["active", "credit_exhausted", "expired", "revoked", "suspended"].sort(),
    );
  });

  it("CreditTransactionType has exactly the five ledger entry types", () => {
    expect(Object.values(CreditTransactionType).sort()).toEqual(
      ["credit_added", "credit_removed", "cost_consumed", "manual_adjustment", "refund"].sort(),
    );
  });
});
