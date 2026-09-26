import { describe, it, expect, vi, beforeEach } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { PublicModelsController } from "./public-models.controller.js";
import { ModelResolver } from "../models/model-resolver.js";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Model } from "@gateway/database";
import { ApiKey } from "@gateway/database";
import { ApiKeyStatus } from "@gateway/contracts";
import { ApiKeyAuthGuard, ApiKeyAuthenticatedRequest } from "../api-keys/api-key-auth.guard.js";
import { GatewayAvailabilityGuard } from "../settings/gateway-availability.guard.js";
import { GeminiApiException } from "./gemini-errors.js";

describe("PublicModelsController", () => {
  let controller: PublicModelsController;
  let modelResolverMock: { resolve: ReturnType<typeof vi.fn> };
  let modelsRepoMock: {
    createQueryBuilder: ReturnType<typeof vi.fn>;
    innerJoin: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    andWhere: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    take: ReturnType<typeof vi.fn>;
    getMany: ReturnType<typeof vi.fn>;
  };
  let mockApiKey: ApiKey;

  beforeEach(async () => {
    modelResolverMock = { resolve: vi.fn() };
    modelsRepoMock = {
      createQueryBuilder: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getMany: vi.fn().mockResolvedValue([]),
    };

    mockApiKey = new ApiKey();
    mockApiKey.allowedEndpoints = ["models.get", "models.list"];
    mockApiKey.status = ApiKeyStatus.ACTIVE;
    mockApiKey.keyHash = "hash";

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicModelsController],
      providers: [
        { provide: ModelResolver, useValue: modelResolverMock },
        { provide: getRepositoryToken(Model), useValue: modelsRepoMock },
        { provide: getRepositoryToken(ApiKey), useValue: {} },
      ],
    })
      .overrideGuard(ApiKeyAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(GatewayAvailabilityGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PublicModelsController>(PublicModelsController);
  });

  describe("mapToResource mapping", () => {
    it("derives supportedGenerationMethods and omits null limits", async () => {
      const mockModel = new Model();
      mockModel.publicName = "gemini-pro";
      mockModel.displayName = "Gemini Pro";
      mockModel.supportsText = true;
      mockModel.supportsEmbeddings = false;
      mockModel.inputTokenLimit = 30720;
      mockModel.outputTokenLimit = null; // null limit

      modelResolverMock.resolve.mockResolvedValue({ model: mockModel, upstream: {} });

      const res = await controller.getModel({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "models/gemini-pro");

      expect(res).toEqual({
        name: "models/gemini-pro",
        baseModelId: "gemini-pro",
        displayName: "Gemini Pro",
        supportedGenerationMethods: ["generateContent", "countTokens"],
        inputTokenLimit: 30720,
      });
      expect(res.outputTokenLimit).toBeUndefined();
    });

    it("uses alias in name if requested via alias", async () => {
      const mockModel = new Model();
      mockModel.publicName = "gemini-pro";
      mockModel.displayName = "Gemini Pro";
      mockModel.supportsText = false;
      mockModel.supportsEmbeddings = true;
      mockModel.inputTokenLimit = null;
      mockModel.outputTokenLimit = null;

      modelResolverMock.resolve.mockResolvedValue({ model: mockModel, upstream: {} });

      const res = await controller.getModel({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "alias-name");

      expect(res).toEqual({
        name: "models/alias-name",
        baseModelId: "gemini-pro",
        displayName: "Gemini Pro",
        supportedGenerationMethods: ["embedContent"],
      });
    });
  });

  describe("list models pagination", () => {
    it("clamps pageSize", async () => {
      await controller.listModels({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "-10", undefined);
      expect(modelsRepoMock.take).toHaveBeenCalledWith(2); // 1 + 1

      await controller.listModels({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "5000", undefined);
      expect(modelsRepoMock.take).toHaveBeenCalledWith(1001); // 1000 + 1
    });

    it("decodes valid pageToken and uses it", async () => {
      const token = Buffer.from("model-b").toString("base64url");
      await controller.listModels({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "10", token);

      expect(modelsRepoMock.andWhere).toHaveBeenCalledWith("model.publicName > :lastPublicName", { lastPublicName: "model-b" });
    });

    it("throws 400 for invalid pageToken", async () => {
      await expect(controller.listModels({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "10", "invalid/token!")).rejects.toThrow(GeminiApiException);
    });
    
    it("encodes nextPageToken correctly", async () => {
      const m1 = new Model(); m1.publicName = "m1";
      const m2 = new Model(); m2.publicName = "m2";
      const m3 = new Model(); m3.publicName = "m3";
      
      modelsRepoMock.getMany.mockResolvedValue([m1, m2, m3]);
      
      const res = await controller.listModels({ apiKey: mockApiKey } as ApiKeyAuthenticatedRequest, "2", undefined);
      
      expect(res.models.length).toBe(2);
      expect(res.models[0]!.baseModelId).toBe("m1");
      expect(res.models[1]!.baseModelId).toBe("m2");
      expect(res.nextPageToken).toBe(Buffer.from("m2").toString("base64url"));
    });
  });
});
