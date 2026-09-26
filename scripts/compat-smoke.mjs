#!/usr/bin/env node
// Checks a running gateway against a real upstream, the way a Gemini client would call it.
// Unit and e2e tests use fake providers; this is the only check that proves the real behaviour.
//
//   GATEWAY_URL=http://localhost:3000 GATEWAY_KEY=lvg_... MODEL=gemini-2.5-flash \
//     EMBED_MODEL=gemini-embedding-001 node scripts/compat-smoke.mjs
//
// The key is read from the environment only and never printed. Exits 1 when a check fails.
import { deflateSync } from "node:zlib";

const baseUrl = (process.env.GATEWAY_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const key = process.env.GATEWAY_KEY;
const model = process.env.MODEL ?? "gemini-2.5-flash";
const embedModel = process.env.EMBED_MODEL;

if (!key) {
  console.error("GATEWAY_KEY is required.");
  process.exit(2);
}

const results = [];

async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({
      name,
      ok: true,
      ms: Date.now() - startedAt,
      detail: detail ?? "",
    });
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function skip(name, reason) {
  results.push({ name, ok: null, ms: 0, detail: reason });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function call(
  path,
  { method = "POST", body, auth = "header", apiKey = key } = {},
) {
  const url = new URL(`${baseUrl}/v1beta/${path}`);
  const headers = { "Content-Type": "application/json" };
  if (auth === "header") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    url.searchParams.set("key", apiKey);
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

function expectOk(res) {
  const upstreamMessage = res.json?.error?.message;
  assert(
    res.status === 200,
    `HTTP ${res.status}${upstreamMessage ? `: ${upstreamMessage}` : ""}`,
  );
  return res.json;
}

function candidateText(json) {
  return (json?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

function textRequest(text, extra = {}) {
  return { contents: [{ role: "user", parts: [{ text }] }], ...extra };
}

// A solid-colour PNG built in memory, so the check needs no fixture files.
function solidPng(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(size * 3, Buffer.from([r, g, b])),
  ]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// One second of a 440 Hz tone as 16-bit mono WAV.
function toneWav(seconds = 1, rate = 16000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767),
      i * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

await check("models.list", async () => {
  const json = expectOk(await call("models", { method: "GET" }));
  const names = (json.models ?? []).map((m) => m.name);
  assert(
    names.includes(`models/${model}`),
    `models/${model} not listed (got ${names.length} models)`,
  );
  return `${names.length} models`;
});

await check("models.get", async () => {
  const json = expectOk(await call(`models/${model}`, { method: "GET" }));
  assert(json.name === `models/${model}`, `unexpected name ${json.name}`);
  return json.displayName ?? "";
});

await check("generateContent (header key)", async () => {
  const json = expectOk(
    await call(`models/${model}:generateContent`, {
      body: textRequest("Reply exactly: gateway works"),
    }),
  );
  const text = candidateText(json);
  assert(
    /gateway works/i.test(text),
    `unexpected reply ${JSON.stringify(text.slice(0, 80))}`,
  );
  assert(
    json.usageMetadata?.promptTokenCount > 0,
    "no usageMetadata.promptTokenCount",
  );
  return `${json.usageMetadata.promptTokenCount} in / ${json.usageMetadata.candidatesTokenCount ?? 0} out`;
});

await check("generateContent (?key=)", async () => {
  expectOk(
    await call(`models/${model}:generateContent`, {
      auth: "query",
      body: textRequest("hello"),
    }),
  );
});

await check("systemInstruction + generationConfig", async () => {
  const json = expectOk(
    await call(`models/${model}:generateContent`, {
      body: textRequest("What is 2+2?", {
        systemInstruction: { parts: [{ text: "Answer with digits only." }] },
        generationConfig: { temperature: 0, maxOutputTokens: 256 },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_ONLY_HIGH",
          },
        ],
      }),
    }),
  );
  const text = candidateText(json).trim();
  assert(
    text.includes("4"),
    `unexpected reply ${JSON.stringify(text.slice(0, 80))}`,
  );
  return text.slice(0, 20);
});

await check("streamGenerateContent (alt=sse, progressive)", async () => {
  const url = new URL(
    `${baseUrl}/v1beta/models/${model}:streamGenerateContent`,
  );
  url.searchParams.set("alt", "sse");
  url.searchParams.set("key", key);
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      textRequest(
        "Count from 1 to 30, one number per line, and write one short sentence about each number.",
      ),
    ),
  });
  // The template literal would be evaluated eagerly and consume the body, so read it only on failure.
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  assert(
    res.headers.get("content-type")?.startsWith("text/event-stream"),
    `content-type ${res.headers.get("content-type")}`,
  );
  const decoder = new TextDecoder();
  const arrivals = [];
  let raw = "";
  for await (const chunk of res.body) {
    arrivals.push(Date.now() - startedAt);
    raw += decoder.decode(chunk, { stream: true });
  }
  const events = raw
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data));
  assert(
    !events.some((e) => e.error),
    `stream error event: ${JSON.stringify(events.find((e) => e.error))}`,
  );
  assert(events.length >= 2, `only ${events.length} events`);
  assert(
    events.some((e) => e.usageMetadata),
    "no usageMetadata in the stream",
  );
  const spread = arrivals[arrivals.length - 1] - arrivals[0];
  assert(
    arrivals.length >= 2 && spread > 0,
    `all bytes arrived at once (${arrivals.length} reads)`,
  );
  return `${events.length} events over ${arrivals.length} reads, first ${arrivals[0]} ms, spread ${spread} ms`;
});

await check("countTokens", async () => {
  const json = expectOk(
    await call(`models/${model}:countTokens`, {
      body: textRequest("How many tokens is this sentence?"),
    }),
  );
  assert(json.totalTokens > 0, `totalTokens ${json.totalTokens}`);
  return `${json.totalTokens} tokens`;
});

await check("function calling (declaration -> call -> response)", async () => {
  const tools = [
    {
      functionDeclarations: [
        {
          name: "get_weather",
          description: "Returns the current weather for a city.",
          parameters: {
            type: "OBJECT",
            properties: { city: { type: "STRING" } },
            required: ["city"],
          },
        },
      ],
    },
  ];
  const question = {
    role: "user",
    parts: [{ text: "What's the weather in Cairo right now?" }],
  };
  const first = expectOk(
    await call(`models/${model}:generateContent`, {
      body: {
        contents: [question],
        tools,
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["get_weather"],
          },
        },
      },
    }),
  );
  const modelTurn = first.candidates?.[0]?.content;
  const fnCall = modelTurn?.parts?.find((p) => p.functionCall)?.functionCall;
  assert(
    fnCall?.name === "get_weather",
    `no get_weather functionCall (${JSON.stringify(modelTurn?.parts ?? []).slice(0, 120)})`,
  );
  const second = expectOk(
    await call(`models/${model}:generateContent`, {
      body: {
        contents: [
          question,
          modelTurn,
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "get_weather",
                  response: {
                    city: fnCall.args?.city ?? "Cairo",
                    temperatureC: 31,
                    sky: "sunny",
                  },
                },
              },
            ],
          },
        ],
        tools,
      },
    }),
  );
  const text = candidateText(second);
  assert(
    /31|sunny/i.test(text),
    `the reply ignores the function response: ${JSON.stringify(text.slice(0, 80))}`,
  );
  return `args ${JSON.stringify(fnCall.args ?? {})}`;
});

await check("image input (inline PNG)", async () => {
  const png = solidPng(64, [220, 20, 20]);
  const json = expectOk(
    await call(`models/${model}:generateContent`, {
      body: {
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: png.toString("base64"),
                },
              },
              { text: "What colour fills this image? Answer with one word." },
            ],
          },
        ],
      },
    }),
  );
  const text = candidateText(json);
  assert(
    /red/i.test(text),
    `unexpected reply ${JSON.stringify(text.slice(0, 80))}`,
  );
  return text.trim().slice(0, 20);
});

await check("audio input (inline WAV)", async () => {
  const json = expectOk(
    await call(`models/${model}:generateContent`, {
      body: {
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: toneWav().toString("base64"),
                },
              },
              { text: "Describe this audio in five words or fewer." },
            ],
          },
        ],
      },
    }),
  );
  const text = candidateText(json);
  assert(text.trim().length > 0, "empty reply");
  return text.trim().slice(0, 40);
});

if (embedModel) {
  await check("embedContent", async () => {
    const json = expectOk(
      await call(`models/${embedModel}:embedContent`, {
        body: { content: { parts: [{ text: "gateway compatibility check" }] } },
      }),
    );
    const values = json.embedding?.values ?? [];
    assert(values.length > 0, "no embedding values");
    return `${values.length} dimensions`;
  });
} else {
  skip("embedContent", "EMBED_MODEL not set");
}

await check("invalid key is rejected in the Gemini error shape", async () => {
  const res = await call(`models/${model}:generateContent`, {
    body: textRequest("hello"),
    apiKey: "lvg_invalid",
  });
  assert(
    res.status === 401 || res.status === 400 || res.status === 403,
    `HTTP ${res.status}`,
  );
  assert(
    typeof res.json?.error?.status === "string" &&
      res.json.error.code === res.status,
    `body ${res.text.slice(0, 120)}`,
  );
  return `${res.status} ${res.json.error.status}`;
});

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL";
  console.log(
    `${mark}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms  ${r.detail}`,
  );
}
const passed = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
const skipped = results.length - passed - failed;
console.log(
  `\n${passed} passed, ${failed} failed, ${skipped} skipped against ${baseUrl} (model ${model}).`,
);
process.exit(failed > 0 ? 1 : 0);
