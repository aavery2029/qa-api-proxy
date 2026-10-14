import test from "node:test";
import assert from "node:assert/strict";
import { verifyTurnstile, SITEVERIFY_URL } from "../lib/turnstile.js";

const HOSTS = ["quikreteqaplantvisit.com", "qa.quikreteqaplantvisit.com"];

function fakeFetch(reply, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { ok: true, json: async () => reply };
  };
}

test("reports missing-token without calling Cloudflare", async () => {
  const calls = [];
  const r = await verifyTurnstile("", { secret: "s", fetchImpl: fakeFetch({ success: true }, calls), allowedHostnames: HOSTS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-token");
  assert.equal(calls.length, 0);
});

test("reports not-configured when no secret is set", async () => {
  const calls = [];
  const r = await verifyTurnstile("tok", { secret: "", fetchImpl: fakeFetch({ success: true }, calls), allowedHostnames: HOSTS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-configured");
  assert.equal(calls.length, 0);
});

test("posts secret, token and remote ip to siteverify and accepts success on an allowed hostname", async () => {
  const calls = [];
  const r = await verifyTurnstile("tok", {
    secret: "sec", remoteip: "203.0.113.9",
    fetchImpl: fakeFetch({ success: true, hostname: "quikreteqaplantvisit.com", action: "qa_submit" }, calls),
    allowedHostnames: HOSTS,
  });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, SITEVERIFY_URL);
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { secret: "sec", response: "tok", remoteip: "203.0.113.9" });
});

test("fails with Cloudflare's error codes when success is false", async () => {
  const r = await verifyTurnstile("tok", {
    secret: "sec", fetchImpl: fakeFetch({ success: false, "error-codes": ["timeout-or-duplicate"] }), allowedHostnames: HOSTS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout-or-duplicate");
});

test("fails with hostname-mismatch when the token was solved on another site", async () => {
  const r = await verifyTurnstile("tok", {
    secret: "sec", fetchImpl: fakeFetch({ success: true, hostname: "evil.example" }), allowedHostnames: HOSTS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "hostname-mismatch");
});

test("gives up on a hung siteverify after the timeout as siteverify-unreachable", async () => {
  // Hangs forever unless an abort signal fires, like a stalled upstream.
  const hung = (url, init) => new Promise((_, reject) => {
    if (init.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const r = await Promise.race([
    verifyTurnstile("tok", { secret: "sec", fetchImpl: hung, allowedHostnames: HOSTS, timeoutMs: 50 }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "test-gave-up-waiting" }), 1500)),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "siteverify-unreachable");
});

test("fails with action-mismatch when the token was issued for another widget action", async () => {
  const r = await verifyTurnstile("tok", {
    secret: "sec", allowedHostnames: HOSTS, expectedAction: "qa_submit",
    fetchImpl: fakeFetch({ success: true, hostname: "quikreteqaplantvisit.com", action: "login" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "action-mismatch");
});

test("fails with siteverify-unreachable when the call throws", async () => {
  const r = await verifyTurnstile("tok", {
    secret: "sec", fetchImpl: fakeFetch(new Error("ECONNRESET")), allowedHostnames: HOSTS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "siteverify-unreachable");
});
