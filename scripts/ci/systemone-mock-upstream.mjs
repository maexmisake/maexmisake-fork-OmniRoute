#!/usr/bin/env node
// Local stand-in for the OpenCode Zen System One endpoints, used only by the
// image smoke test (scripts/ci/systemone-image-smoke.sh). It is reachable inside a
// private container network under the hostname `opencode.ai`, so the app's default
// registry URLs are exercised without any real provider, key or network egress.
//
// It never logs a request body, a credential or a header value: each call is recorded
// as one JSON line holding the method, path, model id, which synthetic key matched
// ("paid" | "free" | "none") and whether the request carried the canary state marker.

import fs from "node:fs";
import https from "node:https";
import { pathToFileURL } from "node:url";

export const DECISION_PATH = "/inference/v1/systemone";
export const MODELS_PATH = "/zen/v1/models";

export const MOCK_CATALOG = {
  object: "list",
  data: [
    { id: "jev-1.13", object: "model" },
    { id: "jev-1.13-free", object: "model" },
    { id: "big-pickle", object: "model" },
    { id: "qwen3-coder", object: "model" },
  ],
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function bearer(req) {
  const header = req.headers.authorization;
  return typeof header === "string" && /^bearer /i.test(header) ? header.slice(7).trim() : "";
}

function answerFor(question) {
  if (question?.type === "noul") {
    return {
      type: "noul",
      noul: 0.87,
      probabilities: { yes: 0.87, no: 0.13 },
      confidence: 0.9,
    };
  }
  if (question?.type === "choice") {
    const options = Object.keys(question.criteria ?? {});
    const chosen = options[0] ?? "none";
    return {
      type: "choice",
      choice: chosen,
      probabilities: Object.fromEntries(options.map((name) => [name, 1 / options.length])),
      confidence: 0.8,
    };
  }
  return { type: "score", score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.7 };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {{ paidKey: string, freeKey: string, stateMarker: string, log?: (entry: object) => void }} options
 */
export function createMockHandler({ paidKey, freeKey, stateMarker, log = () => {} }) {
  let seq = 0;

  return async function handle(req, res) {
    const path = new URL(req.url ?? "/", "http://mock.invalid").pathname;
    const token = bearer(req);
    const keyKind =
      token && token === paidKey ? "paid" : token && token === freeKey ? "free" : "none";
    const entry = { seq: ++seq, method: req.method, path, model: null, keyKind, stateSeen: false };
    const reply = (status, body) => {
      log({ ...entry, status });
      json(res, status, body);
    };

    if (req.method === "POST" && path === DECISION_PATH) {
      if (keyKind === "none") {
        return reply(401, { error: { code: "invalid_api_key", message: "invalid api key" } });
      }
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        return reply(400, { error: { code: "invalid_json", message: "invalid json" } });
      }
      const model = typeof body.model === "string" ? body.model : "";
      const state = typeof body.state === "string" ? body.state : "";
      entry.model = model;
      entry.stateSeen = stateMarker ? state.includes(stateMarker) : false;

      const isFreeModel = /-free$/.test(model);
      if (isFreeModel !== (keyKind === "free")) {
        return reply(403, { error: { code: "tier_mismatch", message: "key tier mismatch" } });
      }
      if (model === "jev-reject") {
        // Echoes the request state and the bearer back, as some real upstreams do.
        return reply(422, {
          error: {
            code: "invalid_state",
            message: `rejected state ${state} for key ${token}`,
          },
        });
      }
      if (model === "jev-contract-violation") {
        return reply(200, { model, answers: {}, debug: { state } });
      }
      const questions = body.questions && typeof body.questions === "object" ? body.questions : {};
      return reply(200, {
        model,
        answers: Object.fromEntries(
          Object.entries(questions).map(([name, question]) => [name, answerFor(question)])
        ),
        usage: { input_tokens: 21, output_tokens: 4, cost: 0.00042 },
      });
    }

    if (req.method === "GET" && path === MODELS_PATH) {
      if (keyKind === "none") {
        return reply(401, { error: { code: "invalid_api_key", message: "invalid api key" } });
      }
      return reply(200, MOCK_CATALOG);
    }

    return reply(404, { error: { code: "not_found", message: "not found" } });
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`systemone-mock-upstream: ${name} is required`);
    process.exit(2);
  }
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const handler = createMockHandler({
    paidKey: requiredEnv("MOCK_PAID_KEY"),
    freeKey: requiredEnv("MOCK_FREE_KEY"),
    stateMarker: requiredEnv("MOCK_STATE_MARKER"),
    log: (entry) => console.log(JSON.stringify({ event: "upstream_call", ...entry })),
  });
  const server = https.createServer(
    {
      cert: fs.readFileSync(requiredEnv("MOCK_CERT_FILE")),
      key: fs.readFileSync(requiredEnv("MOCK_KEY_FILE")),
    },
    (req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: { code: "mock_failure" } });
      });
    }
  );
  const port = Number(process.env.MOCK_PORT || 443);
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "listening", port }));
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
