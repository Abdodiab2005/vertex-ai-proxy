import { vi } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import type { CredentialCipher } from "@gateway/shared";
import { createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import type {
  AIUpstreamProvider,
  JsonObject,
  ProviderModelInfo,
  UpstreamConnectionTestResult,
} from "../src/upstreams/providers/upstream-provider.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";

class RecordingProvider implements AIUpstreamProvider {
  requests: JsonObject[] = [];
  private gate: Promise<void> | null = null;
  private releaseHold: (() => void) | null = null;

  hold(): () => void {
    let release = (): void => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseHold = release;
    return () => {
      release();
      if (this.releaseHold === release) {
        this.releaseHold = null;
        this.gate = null;
      }
    };
  }

  async generateContent(_model: string, body: JsonObject): Promise<JsonObject> {
    this.requests.push(body);
    const gate = this.gate;
    if (gate) {
      await gate;
    }
    return {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 1, totalTokenCount: 301 },
    };
  }

  async streamGenerateContent(): Promise<ReadableStream<Uint8Array>> {
    throw new Error("not used");
  }

  async countTokens(_model: string, body: JsonObject): Promise<JsonObject> {
    this.requests.push(body);
    return { totalTokens: 300 };
  }

  async listModels(): Promise<{ models: ProviderModelInfo[] }> {
    return { models: [] };
  }

  async getModel(model: string): Promise<ProviderModelInfo> {
    return { id: model };
  }

  async embedContent(): Promise<{ response: JsonObject; inputTokens: number | null }> {
    throw new Error("not used");
  }

  async testConnection(): Promise<UpstreamConnectionTestResult> {
    return { status: "connected", httpStatus: 200, message: "OK" };
  }
}

class RecordingFactory extends UpstreamProviderFactory {
  provider = new RecordingProvider();

  forUpstream(): AIUpstreamProvider {
    return this.provider;
  }
}

// 8x8 PNG and a short WAV header + samples, as clients would base64 them.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=",
  "base64",
).toString("base64");
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.alloc(1600)]).toString("base64");

function withMedia(mimeType: string, data: string) {
  return { contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: "Describe this." }] }] };
}

describe("Inline media (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let factory: RecordingFactory;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    factory = new RecordingFactory({} as CredentialCipher);
    app = await createE2eApp({ overrides: [{ provide: UpstreamProviderFactory, useValue: factory }] });
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    factory.provider = new RecordingProvider();
    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), { email: "owner@example.com", password: "correct-horse-1" });
    const login = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.30")
      .send({ email: "owner@example.com", password: "correct-horse-1" })
      .expect(200);
    const parsed = sessionCookie(login);
    cookie = `${parsed.name}=${parsed.value}`;
    csrf = login.body.csrfToken;
  });

  function admin(path: string) {
    return request(app.getHttpServer()).post(path).set("Cookie", cookie).set("x-csrf-token", csrf);
  }

  async function setup(capabilities: { supportsVision?: boolean; supportsAudio?: boolean; supportsFiles?: boolean }) {
    const upstream = await admin("/admin/upstreams")
      .send({ name: "Vertex", projectId: "test-project", location: "us-central1", authMethod: "application-default-credentials" })
      .expect(201);
    const model = await admin("/admin/models")
      .send({ publicName: "gemini-media", upstreamModelName: "gemini-2.5-flash", displayName: "Media", upstreamId: upstream.body.upstream.id, enabled: true, ...capabilities })
      .expect(201);
    for (const [billingDimension, price] of [["input_tokens", "1.00"], ["output_tokens", "2.00"]]) {
      await admin(`/admin/models/${model.body.model.id}/pricing`).send({ billingDimension, unitSize: "1000000", price, currency: "USD" }).expect(201);
    }
    const key = await admin("/admin/api-keys").send({ name: "Media key" }).expect(201);
    await admin(`/admin/api-keys/${key.body.apiKey.id}/credits`).send({ type: "credit_added", amount: "5.00", description: "Media tests" }).expect(201);
    return { secret: key.body.rawKey as string, keyId: key.body.apiKey.id as string };
  }

  function generate(secret: string, body: JsonObject) {
    return request(app.getHttpServer()).post("/v1beta/models/gemini-media:generateContent").set("x-goog-api-key", secret).send(body);
  }

  it("forwards an inline image unchanged to a vision model", async () => {
    const { secret } = await setup({ supportsVision: true });
    const body = withMedia("image/png", PNG);

    await generate(secret, body).expect(200);
    // The image is forwarded as sent. An omitted maxOutputTokens is filled with the output hold.
    expect(factory.provider.requests).toEqual([
      { ...body, generationConfig: { maxOutputTokens: 8192 } },
    ]);
  });

  it("forwards inline audio to an audio model", async () => {
    const { secret } = await setup({ supportsAudio: true });
    await generate(secret, withMedia("audio/wav", WAV)).expect(200);
    expect(factory.provider.requests).toHaveLength(1);
  });

  it.each([
    ["an image to a model without vision", { supportsAudio: true }, () => withMedia("image/png", PNG)],
    ["audio to a model without audio", { supportsVision: true }, () => withMedia("audio/wav", WAV)],
    ["an unsupported MIME type", { supportsVision: true }, () => withMedia("application/x-msdownload", PNG)],
    ["invalid base64", { supportsVision: true }, () => withMedia("image/png", "not base64!")],
  ])("rejects %s with 400 before calling the upstream or reserving credit", async (_name, capabilities, body) => {
    const { secret, keyId } = await setup(capabilities);

    const res = await generate(secret, body()).expect(400);
    expect(res.body.error).toEqual(expect.objectContaining({ code: 400, status: "INVALID_ARGUMENT" }));
    expect(factory.provider.requests).toHaveLength(0);
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
    const usage = await dataSource.query("SELECT 1 FROM usage_records WHERE api_key_id = $1", [keyId]);
    expect(usage).toHaveLength(0);
  });

  it("enforces the media.maxInlineBytes setting, countTokens included", async () => {
    const { secret } = await setup({ supportsVision: true });
    await app
      .get(SettingsService)
      .update({ "media.maxInlineBytes": 1024 }, { adminUserId: "00000000-0000-0000-0000-000000000000", ipAddress: null });
    const big = Buffer.alloc(2048, 1).toString("base64");

    const res = await generate(secret, withMedia("image/png", big)).expect(400);
    expect(res.body.error.status).toBe("INVALID_ARGUMENT");
    await request(app.getHttpServer())
      .post("/v1beta/models/gemini-media:countTokens")
      .set("x-goog-api-key", secret)
      .send(withMedia("image/png", big))
      .expect(400);
    expect(factory.provider.requests).toHaveLength(0);

    await generate(secret, withMedia("image/png", PNG)).expect(200);
  });

  it("rejects fileData until media.allowFileUris is enabled, and inline data without a MIME type", async () => {
    const { secret, keyId } = await setup({ supportsFiles: true, supportsVision: true });
    const fileBody = {
      contents: [{ role: "user", parts: [{ fileData: { mimeType: "application/pdf", fileUri: "gs://bucket/object.pdf" } }] }],
    };

    const rejected = await generate(secret, fileBody).expect(400);
    expect(rejected.body.error).toEqual(
      expect.objectContaining({
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "fileData parts are disabled on this gateway; send the media inline.",
      }),
    );
    expect(factory.provider.requests).toHaveLength(0);
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);

    const missingMime = await generate(secret, {
      contents: [{ role: "user", parts: [{ inlineData: { data: PNG } }] }],
    }).expect(400);
    expect(missingMime.body.error.status).toBe("INVALID_ARGUMENT");
    expect(factory.provider.requests).toHaveLength(0);

    await app
      .get(SettingsService)
      .update(
        { "media.allowFileUris": true },
        { adminUserId: "00000000-0000-0000-0000-000000000000", ipAddress: null },
      );
    await generate(secret, fileBody).expect(200);
    expect(factory.provider.requests).toHaveLength(1);
  });

  it("reserves more credit for a larger inline audio part than a small one", async () => {
    const { secret, keyId } = await setup({ supportsAudio: true });
    const store = app.get(CreditReservationStore);
    const small = Buffer.alloc(1_000).toString("base64");
    const large = Buffer.alloc(600_000).toString("base64");

    async function reservedDuring(body: JsonObject, seen: number): Promise<bigint> {
      const release = factory.provider.hold();
      const pending = generate(secret, body).then((res) => res);
      try {
        await vi.waitFor(() => expect(factory.provider.requests).toHaveLength(seen), { timeout: 5_000 });
        return await store.activeReservedMicros(keyId);
      } finally {
        release();
        expect((await pending).status).toBe(200);
      }
    }

    const largeHold = await reservedDuring(withMedia("audio/wav", large), 1);
    expect(await store.activeReservedMicros(keyId)).toBe(0n);
    const smallHold = await reservedDuring(withMedia("audio/wav", small), 2);
    expect(largeHold > smallHold).toBe(true);
  });
});
