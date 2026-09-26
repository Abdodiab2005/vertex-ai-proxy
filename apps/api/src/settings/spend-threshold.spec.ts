import { describe, expect, it } from "vitest";
import { SPEND_TRACKED_LABEL, isThresholdReached, usableTargetFor } from "./spend-threshold.js";

describe("spend threshold", () => {
  it("names the tracked figure exactly", () => {
    expect(SPEND_TRACKED_LABEL).toBe("Gateway tracked / estimated upstream spend");
  });

  it("subtracts the reserve from the budget in micro-units", () => {
    expect(usableTargetFor("300", "20")).toBe("280.000000");
    expect(usableTargetFor("10.000001", "10")).toBe("0.000001");
    expect(usableTargetFor("10", "10.000001")).toBe("-0.000001");
    expect(usableTargetFor("0", "0")).toBe("0.000000");
    expect(usableTargetFor(null, "20")).toBeNull();
  });

  it.each([
    ["1.000000", "1.000000", true],
    ["1.000001", "1.000000", true],
    ["0.999999", "1.000000", false],
    ["0", "0.000000", true],
    ["999999999999.000002", "999999999999.000001", true],
    ["999999999999.000001", "999999999999.000002", false],
    ["999999999999.000001", "999999999999.000001", true],
    ["0", null, false],
    ["5.5", null, false],
  ] as const)("tracked %s against usable target %s is reached=%s", (tracked, target, reached) => {
    expect(isThresholdReached(tracked, target)).toBe(reached);
  });
});
