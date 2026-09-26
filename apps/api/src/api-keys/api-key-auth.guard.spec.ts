import { describe, expect, it } from "vitest";
import { assertModelAllowed, assertEndpointAllowed } from "./api-key-auth.guard.js";
import { ApiKey } from "@gateway/database";
import { GeminiApiException } from "../public-api/gemini-errors.js";

describe("api-key-auth.guard", () => {
  describe("assertModelAllowed", () => {
    it("allows any model if no restrictions", () => {
      const key = new ApiKey();
      key.allowedModels = [];
      key.blockedModels = [];
      expect(() => assertModelAllowed(key, "gemini-pro")).not.toThrow();
    });

    it("blocks model in blockedModels", () => {
      const key = new ApiKey();
      key.allowedModels = [];
      key.blockedModels = ["gemini-pro"];
      expect(() => assertModelAllowed(key, "gemini-pro")).toThrow(GeminiApiException);
      try {
        assertModelAllowed(key, "gemini-pro");
      } catch (e: unknown) {
        expect((e as GeminiApiException).getStatus()).toBe(403);
      }
    });

    it("requires model in allowedModels if not empty", () => {
      const key = new ApiKey();
      key.allowedModels = ["gemini-pro"];
      key.blockedModels = [];
      expect(() => assertModelAllowed(key, "gemini-pro")).not.toThrow();
      expect(() => assertModelAllowed(key, "gemini-ultra")).toThrow(GeminiApiException);
    });

    it("blocked overrides allowed", () => {
      const key = new ApiKey();
      key.allowedModels = ["gemini-pro"];
      key.blockedModels = ["gemini-pro"];
      expect(() => assertModelAllowed(key, "gemini-pro")).toThrow(GeminiApiException);
    });

    it("evaluates allow/block lists against the whole name set of public name and aliases", () => {
      const key = new ApiKey();
      // Block by alias -> blocks even when requesting via public name or another alias
      key.allowedModels = [];
      key.blockedModels = ["pro-alias"];
      expect(() => assertModelAllowed(key, ["gemini-2.5-pro", "pro-alias"])).toThrow(GeminiApiException);
      expect(() => assertModelAllowed(key, ["gemini-2.5-pro", "pro-alias"], "gemini-2.5-pro")).toThrow(GeminiApiException);

      // Allow only by alias -> allows access when requesting via public name or alias
      const keyAllowAlias = new ApiKey();
      keyAllowAlias.allowedModels = ["pro-alias"];
      keyAllowAlias.blockedModels = [];
      expect(() => assertModelAllowed(keyAllowAlias, ["gemini-2.5-pro", "pro-alias"])).not.toThrow();

      // Disallow if neither public name nor any alias is in allowedModels
      expect(() => assertModelAllowed(keyAllowAlias, ["gemini-2.5-flash", "flash-alias"])).toThrow(GeminiApiException);

      // Blocked by alias overrides allowed by public name
      const keyConflict = new ApiKey();
      keyConflict.allowedModels = ["gemini-2.5-pro"];
      keyConflict.blockedModels = ["pro-alias"];
      expect(() => assertModelAllowed(keyConflict, ["gemini-2.5-pro", "pro-alias"])).toThrow(GeminiApiException);
    });
  });

  describe("assertEndpointAllowed", () => {
    it("allows known endpoints when allowedEndpoints is empty", () => {
      const key = new ApiKey();
      key.allowedEndpoints = [];
      expect(() => assertEndpointAllowed(key, "generateContent")).not.toThrow();
    });

    it("blocks endpoint if allowedEndpoints is not empty and missing", () => {
      const key = new ApiKey();
      key.allowedEndpoints = ["generateContent"];
      expect(() => assertEndpointAllowed(key, "generateContent")).not.toThrow();
      expect(() => assertEndpointAllowed(key, "countTokens")).toThrow(GeminiApiException);
    });

    it("treats an embedContent grant as permission to call batchEmbedContents", () => {
      const key = new ApiKey();
      key.allowedEndpoints = ["embedContent"];
      expect(() => assertEndpointAllowed(key, "batchEmbedContents")).not.toThrow();
      expect(() => assertEndpointAllowed(key, "embedContent")).not.toThrow();
      expect(() => assertEndpointAllowed(key, "generateContent")).toThrow(GeminiApiException);
    });

    it("allows batchEmbedContents when it is listed on its own", () => {
      const key = new ApiKey();
      key.allowedEndpoints = ["batchEmbedContents"];
      expect(() => assertEndpointAllowed(key, "batchEmbedContents")).not.toThrow();
      expect(() => assertEndpointAllowed(key, "embedContent")).toThrow(GeminiApiException);
    });
  });
});
