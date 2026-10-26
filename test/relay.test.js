// Sign-in and supplier relays (lib/relay.js) plus the submit route's new
// guards. No network: fetch is injected and every call is recorded.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayHandler, SIGNIN_TURNSTILE_ACTION } from "../lib/relay.js";
import { createHandler } from "../lib/handler.js";
import { validatePayload } from "../lib/validate.js";
import { SITEVERIFY_URL } from "../lib/turnstile.js";
import { goodPayload } from "./fixtures.js";

const APPS = "https://script.google.com/macros/s/TEST/exec";
const ORIGIN = "https://quikreteqaplantvisit.com";
const SESSION = "eyJ2IjoxLCJlIjoicGF0QGV4YW1wbGUuY29tIn0." + "a1".repeat(32);
const SYNC_SECRET = "sync-secret-0123456789-abcdef";

function fakeFetch(replies, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const reply = replies[url];
    if (!reply) throw new Error("unexpected fetch " + url);
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => text, json: async () => JSON.parse(text) };
  };
}
const fakeReq = (method, body, headers = {}) => ({ method, body, headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.9", ...headers } });
function fakeRes() {
  const res = { statusCode: 200, headers: {}, payload: undefined };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  res.end = () => res;
  return res;
}

function relay(action, {
  env = { TURNSTILE_SECRET: "ts", FORM_SECRET: "form-secret-xyz" },
  turnstile = { success: true, hostname: "quikreteqaplantvisit.com", action: SIGNIN_TURNSTILE_ACTION },
  apps = { status: 200, body: { status: "ok" } },
} = {}) {
  const calls = [];
  const logs = { info: [], warn: [], error: [] };
  const handler = createRelayHandler(action, {
    env: { APPS_SCRIPT_URL: APPS, ...env },
    fetchImpl: fakeFetch({ [SITEVERIFY_URL]: { status: 200, body: turnstile }, [APPS]: apps }, calls),
    log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(String(m)) },
  });
  const call = async (body, method = "POST", headers) => { const res = fakeRes(); await handler(fakeReq(method, body, headers), res); return res; };
  return { call, calls, logs, apps: () => calls.filter((c) => c.url === APPS), siteverify: () => calls.filter((c) => c.url === SITEVERIFY_URL) };
}
const allLogs = (logs) => [...logs.info, ...logs.warn, ...logs.error].join("\n");

// ---------- every route ----------
for (const action of ["request_code", "verify_code", "suppliers", "sync_suppliers"]) {
  test(`${action}: OPTIONS answers with CORS for our origin; GET is 405; no APPS_SCRIPT_URL is 500`, async () => {
    const r = relay(action);
    const opt = await r.call(undefined, "OPTIONS");
    assert.equal(opt.statusCode, 200);
    assert.equal(opt.headers["Access-Control-Allow-Origin"], ORIGIN);
    const evil = await r.call(undefined, "OPTIONS", { origin: "https://evil.example" });
    assert.equal(evil.headers["Access-Control-Allow-Origin"], undefined);
    assert.equal((await r.call(undefined, "GET")).statusCode, 405);
    const none = relay(action, { env: { APPS_SCRIPT_URL: "" } });
    assert.equal((await none.call({ email: "a@b.co" })).statusCode, 500);
    assert.equal(r.apps().length, 0);
  });

  test(`${action}: a non-object or oversized body is refused, never forwarded`, async () => {
    for (const body of ["text", 42, [1], null, undefined]) {
      const r = relay(action);
      const res = await r.call(body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(r.apps().length, 0);
    }
    const r = relay(action);
    const res = await r.call({ email: "a@b.co", code: "123456", session: SESSION, sync_secret: SYNC_SECRET, pad: "x".repeat(700_000) });
    assert.equal(res.statusCode, 413);
    assert.equal(r.apps().length, 0);
  });
}

test("unknown relay action throws at build time (a typo can't ship a dead route)", () => {
  assert.throws(() => createRelayHandler("passthrough", {}), /unknown relay action/);
});

// ---------- request_code ----------
test("request_code: Turnstile is enforced even with TURNSTILE_ENFORCE unset; no token = 403, nothing forwarded", async () => {
  const r = relay("request_code");
  const res = await r.call({ email: "pat@quikrete-readymix.com" });
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.message, /try again/i);
  assert.equal(r.apps().length, 0);
});

test("request_code: TURNSTILE_SECRET missing fails closed with 503", async () => {
  const r = relay("request_code", { env: { FORM_SECRET: "form-secret-xyz" } });
  const res = await r.call({ email: "pat@quikrete-readymix.com", cf_turnstile_token: "tok" });
  assert.equal(res.statusCode, 503);
  assert.equal(r.apps().length, 0);
});

test("request_code: a token minted for the submit widget (action qa_submit) is refused", async () => {
  const r = relay("request_code", { turnstile: { success: true, hostname: "quikreteqaplantvisit.com", action: "qa_submit" } });
  const res = await r.call({ email: "pat@quikrete-readymix.com", cf_turnstile_token: "tok" });
  assert.equal(res.statusCode, 403);
  assert.equal(r.apps().length, 0);
  assert.ok(r.logs.warn.some((m) => /action-mismatch/.test(m)), r.logs.warn.join("\n"));
});

test("request_code: a failed siteverify is 403; the form's own failure reason is logged", async () => {
  const r = relay("request_code", { turnstile: { success: false, "error-codes": ["timeout-or-duplicate"] } });
  const res = await r.call({ email: "pat@quikrete-readymix.com", cf_turnstile_token: "tok", cf_turnstile_error: "error:600010" });
  assert.equal(res.statusCode, 403);
  assert.ok(r.logs.warn.some((m) => /timeout-or-duplicate/.test(m) && /client="error:600010"/.test(m)));
});

test("request_code: verified -> forwards ONLY action, email, the verdict, test_mode and the form secret", async () => {
  const r = relay("request_code");
  const res = await r.call({
    email: " pat@quikrete-readymix.com ", cf_turnstile_token: "tok",
    // everything below is the caller's and must not reach the script
    action: "sync_suppliers", sync_secret: "x", form_secret: "guess", passthrough: true, turnstile_verified: true, test_mode: false, extra: "1",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(r.apps()[0].body, { action: "request_code", email: "pat@quikrete-readymix.com", passthrough: true, test_mode: true, turnstile_verified: true, form_secret: "form-secret-xyz" });
  assert.equal(r.siteverify()[0].body.remoteip, "203.0.113.9");
  assert.deepEqual(res.payload, { status: "ok" });
});

test("request_code: a bad email is 400 before Turnstile is spent", async () => {
  const r = relay("request_code");
  const res = await r.call({ email: "not-an-email", cf_turnstile_token: "tok" });
  assert.equal(res.statusCode, 400);
  assert.equal(r.calls.length, 0);
});

// ---------- verify_code ----------
test("verify_code: forwards email + code, hands the session back as the script sent it", async () => {
  const reply = { status: "ok", session: SESSION, expires: 1, email: "pat@quikrete-readymix.com", name: "Pat" };
  const r = relay("verify_code", { apps: { status: 200, body: reply } });
  const res = await r.call({ email: "pat@quikrete-readymix.com", code: "123 456", form_secret: "guess", action: "suppliers" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, reply);
  assert.deepEqual(r.apps()[0].body, { action: "verify_code", email: "pat@quikrete-readymix.com", code: "123456", passthrough: true, test_mode: true, form_secret: "form-secret-xyz" });
  assert.equal(r.siteverify().length, 0, "no Turnstile on the code check (5 tries per code limit it)");
});

test("verify_code: anything but 6 digits is 400, never forwarded", async () => {
  for (const code of ["12345", "1234567", "12a456", 123456, "", undefined]) {
    const r = relay("verify_code");
    const res = await r.call({ email: "pat@quikrete-readymix.com", code });
    assert.equal(res.statusCode, 400, String(code));
    assert.equal(r.apps().length, 0);
  }
});

// ---------- suppliers ----------
test("suppliers: forwards only the session; refuses a missing or odd looking one", async () => {
  const r = relay("suppliers", { apps: { status: 200, body: { status: "ok", suppliers: { SAND: ["A"] }, plants: {} } } });
  const res = await r.call({ session: SESSION, plant: "704", email: "x@y.z" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(r.apps()[0].body, { action: "suppliers", session: SESSION, passthrough: true, test_mode: true, form_secret: "form-secret-xyz" });
  for (const session of [undefined, "", "abc", SESSION + "<script>", "a.".repeat(600)]) {
    const r2 = relay("suppliers");
    assert.equal((await r2.call({ session })).statusCode, 400, String(session).slice(0, 20));
    assert.equal(r2.apps().length, 0);
  }
});

test("suppliers: the script's 'sign in again' answer passes through for the form to act on", async () => {
  const r = relay("suppliers", { apps: { status: 200, body: { status: "error", code: "session", message: "Please sign in again." } } });
  const res = await r.call({ session: SESSION });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.code, "session");
});

test("a Google login page or other non-JSON reply becomes a clean 502, never raw HTML", async () => {
  const r = relay("suppliers", { apps: { status: 200, body: "<html>Sign in - Google Accounts</html>" } });
  const res = await r.call({ session: SESSION });
  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.status, "error");
  assert.ok(!JSON.stringify(res.payload).includes("<html>"));
  const down = relay("suppliers", { apps: new Error("ECONNRESET") });
  assert.equal((await down.call({ session: SESSION })).statusCode, 502);
});

// ---------- sync_suppliers (Dashboard1) ----------
const syncBody = (extra = {}) => ({
  sync_secret: SYNC_SECRET,
  suppliers: [{ material: "SAND", supplier: "Sand Supplier A" }],
  plants: [{ plant: 704, slot: "Aggregate 1", material: "SAND", supplier: "Sand Supplier A", receipts: 120 }, { plant: "705", slot: "Silo 1", material: "CEMENT", supplier: "" }],
  ...extra,
});

test("sync_suppliers: forwards the whitelisted fields; the secret goes to the script and nowhere else", async () => {
  const r = relay("sync_suppliers", { apps: { status: 200, body: { status: "ok", plant_rows_written: 2 } } });
  const res = await r.call(syncBody({ dry_run: true, action: "request_code", form_secret: "guess", junk: 1 }), "POST", { origin: undefined });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(r.apps()[0].body, {
    action: "sync_suppliers", sync_secret: SYNC_SECRET, passthrough: true, test_mode: true, form_secret: "form-secret-xyz", dry_run: true,
    suppliers: [{ material: "SAND", supplier: "Sand Supplier A" }],
    plants: [{ plant: "704", slot: "Aggregate 1", material: "SAND", supplier: "Sand Supplier A", receipts: 120 }, { plant: "705", slot: "Silo 1", material: "CEMENT", supplier: "" }],
  });
  assert.ok(!allLogs(r.logs).includes(SYNC_SECRET));
  assert.ok(r.logs.info.some((m) => /action=sync_suppliers suppliers=1 plants=2 dry_run=true/.test(m)), r.logs.info.join("\n"));
});

test("sync_suppliers: no secret, a short secret or bad rows are refused before the script", async () => {
  const bad = [
    syncBody({ sync_secret: undefined }),
    syncBody({ sync_secret: "short" }),
    syncBody({ plants: "704" }),
    syncBody({ plants: [{ plant: "704", slot: "Aggregate 1" }] }),
    syncBody({ plants: [{ plant: "704", slot: "Aggregate 1", material: "SAND", receipts: -1 }] }),
    syncBody({ dry_run: "yes" }),
  ];
  for (const body of bad) {
    const r = relay("sync_suppliers");
    const res = await r.call(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.apps().length, 0);
  }
  const many = relay("sync_suppliers");
  const big = await many.call(syncBody({ plants: Array.from({ length: 2001 }, () => ({ plant: "704", slot: "Silo 1", material: "CEMENT" })) }));
  assert.equal(big.statusCode, 413);
});

// ---------- logs never carry a code, a session, a secret or an address ----------
test("relay logs name the route and an email's domain only", async () => {
  const r1 = relay("request_code");
  await r1.call({ email: "pat.person@quikrete-readymix.com", cf_turnstile_token: "tok" });
  const r2 = relay("verify_code");
  await r2.call({ email: "pat.person@quikrete-readymix.com", code: "987654" });
  const r3 = relay("suppliers");
  await r3.call({ session: SESSION });
  const text = [r1, r2, r3].map((r) => allLogs(r.logs)).join("\n");
  assert.ok(!/pat\.person/.test(text), text);
  assert.ok(!text.includes("987654"));
  assert.ok(!text.includes(SESSION));
  assert.ok(!text.includes("form-secret-xyz"), "form secret never logged");
  assert.ok(/domain="quikrete-readymix.com"/.test(text));
});

// ---------- the submit route can't reach the new actions ----------
test("submit: action, turnstile_verified and sync_secret are stripped; the session goes through", async () => {
  const calls = [];
  const logs = { info: [], warn: [] };
  const handler = createHandler({
    env: { APPS_SCRIPT_URL: APPS },
    fetchImpl: fakeFetch({ [SITEVERIFY_URL]: { status: 200, body: { success: true, hostname: "quikreteqaplantvisit.com", action: "qa_submit" } }, [APPS]: { status: 200, body: { status: "ok" } } }, calls),
    log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
  });
  const res = fakeRes();
  await handler(fakeReq("POST", goodPayload({ action: "request_code", turnstile_verified: true, sync_secret: "x", session: SESSION })), res);
  assert.equal(res.statusCode, 200);
  const fwd = calls.find((c) => c.url === APPS).body;
  assert.equal("action" in fwd, false);
  assert.equal("turnstile_verified" in fwd, false);
  assert.equal("sync_secret" in fwd, false);
  assert.equal(fwd.session, SESSION);
  assert.ok(logs.info.some((m) => / session=yes /.test(m)), logs.info.join("\n"));
  assert.ok(!logs.info.join("\n").includes(SESSION));
});

test("submit schema: the session is bounded (1,024 characters)", () => {
  assert.equal(validatePayload(goodPayload({ session: SESSION })).ok, true);
  const v = validatePayload(goodPayload({ session: "x".repeat(1025) }));
  assert.equal(v.ok, false);
  assert.match(v.message, /session/);
});

// ---------- nothing private in this public repo ----------
// The words to look for are private themselves, so they live OUTSIDE this
// repo: a JSON list of strings in QA_PRIVATE_WORDS (default: the QA reference
// folder on Dashboard1). Without that file the check is skipped.
const PRIVATE_WORDS = process.env.QA_PRIVATE_WORDS || "C:/qa-plant-visit-reference/private_words.json";
test("the public repo holds no roster, supplier list or plant data", { skip: !fs.existsSync(PRIVATE_WORDS) && "no private word list here" }, () => {
  const words = JSON.parse(fs.readFileSync(PRIVATE_WORDS, "utf8"));
  assert.ok(Array.isArray(words) && words.length > 5, "private word list looks empty");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  })(root);
  const text = files.map((f) => fs.readFileSync(f, "utf8")).join("\n").toLowerCase();
  const found = words.filter((w) => text.includes(String(w).toLowerCase()));
  assert.deepEqual(found, [], "private words in the public repo");
});
