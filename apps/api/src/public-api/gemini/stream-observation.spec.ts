import { describe, expect, it } from "vitest";
import { StreamObservation } from "./stream-observation.js";

describe("StreamObservation", () => {
  it("ignores usageMetadata without token counts, as Vertex sends on every event but the last", () => {
    const observed = new StreamObservation();
    observed.onEvent({ candidates: [{ content: { parts: [{ text: "1\n2" }] } }], usageMetadata: { trafficType: "ON_DEMAND" } });
    expect(observed.usageMetadata).toBeUndefined();

    observed.onEvent({ usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 110, trafficType: "ON_DEMAND" } });
    expect(observed.usageMetadata).toEqual({ promptTokenCount: 14, candidatesTokenCount: 110, trafficType: "ON_DEMAND" });
  });

  it("keeps the latest usage that carries counts", () => {
    const observed = new StreamObservation();
    observed.onEvent({ usageMetadata: { totalTokenCount: 3 } });
    observed.onEvent({ usageMetadata: { totalTokenCount: 7 } });
    observed.onEvent({ usageMetadata: { trafficType: "ON_DEMAND" } });
    expect(observed.usageMetadata).toEqual({ totalTokenCount: 7 });
  });

  it("counts delivered answer text and function-call arguments", () => {
    const observed = new StreamObservation();
    observed.onEvent({ candidates: [{ content: { parts: [{ text: "hello" }, { text: " world" }] } }] });
    observed.onEvent({ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { a: 1 } } }] } }] });
    observed.onEvent({ candidates: ["not an object", { content: "nope" }] });

    expect(observed.deliveredTextChars).toBe(11 + JSON.stringify({ name: "f", args: { a: 1 } }).length);
  });
});
