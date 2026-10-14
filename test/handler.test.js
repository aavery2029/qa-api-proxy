import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../lib/handler.js";
import { SITEVERIFY_URL } from "../lib/turnstile.js";
import { goodPayload } from "./fixtures.js";

const APPS = "https://script.google.com/macros/s/TEST/exec";
const ORIGIN = "https://quikreteqaplantvisit.com";

// Routes fetch calls by URL and records them. Each reply: {status, body} where
// body is an object (JSON) or a string (raw text).
function fakeFetch(replies, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const reply = replies[url];
    if (!reply) throw new Error("unexpected fetch " + url);
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
}

function fakeReq(method, body, headers = {}) {
  return { method, body, headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers } };
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, payload: undefined, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; res.ended = true; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

function setup({ env = {}, turnstile = { success: true, hostname: "quikreteqaplantvisit.com" }, apps = { status: 200, body: { status: "ok", version: "v4.2" } } } = {}) {
  const calls = [];
  const logs = { info: [], warn: [] };
  const handler = createHandler({
    env: { APPS_SCRIPT_URL: APPS, ...env },
    fetchImpl: fakeFetch({ [SITEVERIFY_URL]: { status: 200, body: turnstile }, [APPS]: apps }, calls),
    log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
  });
  const appsCalls = () => calls.filter((c) => c.url === APPS);
  const siteverifyCalls = () => calls.filter((c) => c.url === SITEVERIFY_URL);
  return { handler, calls, logs, appsCalls, siteverifyCalls };
}

test("answers OPTIONS with CORS headers for an allowed origin", async () => {
  const { handler, calls } = setup();
  const res = fakeRes();
  await handler(fakeReq("OPTIONS", undefined), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], ORIGIN);
  assert.equal(calls.length, 0);
});

test("does not echo an unknown origin", async () => {
  const { handler } = setup();
  const res = fakeRes();
  await handler(fakeReq("OPTIONS", undefined, { origin: "https://evil.example" }), res);
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
});

test("rejects non-POST with 405", async () => {
  const { handler, calls } = setup();
  const res = fakeRes();
  await handler(fakeReq("GET", undefined), res);
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});

test("fails with 500 when APPS_SCRIPT_URL is missing", async () => {
  const { handler } = setup({ env: { APPS_SCRIPT_URL: "" } });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload()), res);
  assert.equal(res.statusCode, 500);
});

test("enforcement off: forwards a good payload, strips the token, injects FORM_SECRET", async () => {
  const { handler, appsCalls, siteverifyCalls } = setup({ env: { FORM_SECRET: "fs", TURNSTILE_SECRET: "ts" } });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload()), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { status: "ok", version: "v4.2" });
  assert.equal(appsCalls().length, 1);
  const forwarded = appsCalls()[0].body;
  assert.equal(forwarded.form_secret, "fs");
  assert.equal("cf_turnstile_token" in forwarded, false);
  assert.equal(forwarded.plant, "705 Manvel");
  assert.equal(siteverifyCalls().length, 1, "token is verified (and logged) even when not enforced");
});

test("enforcement off: falls back to SHARED_SECRET when FORM_SECRET is unset", async () => {
  const { handler, appsCalls } = setup({ env: { SHARED_SECRET: "shared" } });
  await handler(fakeReq("POST", goodPayload()), fakeRes());
  assert.equal(appsCalls()[0].body.form_secret, "shared");
});

test("enforcement off: still forwards an invalid body but logs that it would be rejected", async () => {
  const { handler, appsCalls, logs } = setup();
  const res = fakeRes();
  const body = goodPayload();
  delete body.report;
  await handler(fakeReq("POST", body), res);
  assert.equal(res.statusCode, 200);
  assert.equal(appsCalls().length, 1);
  assert.ok(logs.warn.some((m) => /would reject/i.test(m) && /report/i.test(m)), logs.warn.join("\n"));
});

test("enforcement off: never forwards client passthrough or form_secret even unenforced", async () => {
  const { handler, appsCalls } = setup();
  await handler(fakeReq("POST", goodPayload({ passthrough: true, form_secret: "guess" })), fakeRes());
  const forwarded = appsCalls()[0].body;
  assert.equal("passthrough" in forwarded, false);
  assert.equal(forwarded.form_secret, undefined);
});

test("enforcement on: schema failure returns its status and message, nothing forwarded", async () => {
  const { handler, appsCalls } = setup({ env: { TURNSTILE_ENFORCE: "1", TURNSTILE_SECRET: "ts" } });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload({ email: "nope" })), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.status, "error");
  assert.match(res.payload.message, /email/i);
  assert.equal(appsCalls().length, 0);
});

test("enforcement on: missing token is 403, nothing forwarded", async () => {
  const { handler, appsCalls } = setup({ env: { TURNSTILE_ENFORCE: "1", TURNSTILE_SECRET: "ts" } });
  const res = fakeRes();
  const body = goodPayload();
  delete body.cf_turnstile_token;
  await handler(fakeReq("POST", body), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.status, "error");
  assert.equal(appsCalls().length, 0);
});

test("enforcement on: failed siteverify is 403 with a reload hint", async () => {
  const { handler, appsCalls } = setup({
    env: { TURNSTILE_ENFORCE: "1", TURNSTILE_SECRET: "ts" },
    turnstile: { success: false, "error-codes": ["timeout-or-duplicate"] },
  });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload()), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.message, /try again/i);
  assert.equal(appsCalls().length, 0);
});

test("enforcement on: no TURNSTILE_SECRET fails closed with 503", async () => {
  const { handler, appsCalls } = setup({ env: { TURNSTILE_ENFORCE: "1" } });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload()), res);
  assert.equal(res.statusCode, 503);
  assert.equal(appsCalls().length, 0);
});

test("enforcement on: valid submission is forwarded with the visitor ip sent to siteverify", async () => {
  const { handler, appsCalls, siteverifyCalls } = setup({ env: { TURNSTILE_ENFORCE: "1", TURNSTILE_SECRET: "ts", FORM_SECRET: "fs" } });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(appsCalls().length, 1);
  assert.equal(siteverifyCalls()[0].body.remoteip, "203.0.113.9");
  assert.equal(siteverifyCalls()[0].body.secret, "ts");
});

test("passes Apps Script errors and non-JSON replies through like the original proxy", async () => {
  const errored = setup({ apps: { status: 500, body: { status: "error", message: "not authorized" } } });
  const res1 = fakeRes();
  await errored.handler(fakeReq("POST", goodPayload()), res1);
  assert.equal(res1.statusCode, 500);
  assert.deepEqual(res1.payload, { status: "error", message: "not authorized" });

  const html = setup({ apps: { status: 200, body: "<html>login</html>" } });
  const res2 = fakeRes();
  await html.handler(fakeReq("POST", goodPayload()), res2);
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(res2.payload, { raw: "<html>login</html>", status: "success" });
});
