// QA Plant Visit submission proxy: browser form -> this function -> Apps Script.
//
// Three protections, all configured by Vercel environment variables:
//   schema validation   always evaluated (lib/validate.js)
//   Turnstile           always evaluated when a token arrives (lib/turnstile.js)
//   shared secret       FORM_SECRET (or legacy SHARED_SECRET) injected server-side,
//                       so the Apps Script can fail closed on anything not from here
//
// TURNSTILE_ENFORCE unset/0  = log-only: verdicts go to the runtime log, every
//                              request is forwarded as before (safe rollout mode)
// TURNSTILE_ENFORCE=1        = reject: 400 schema, 403 Turnstile, 413 size,
//                              503 if TURNSTILE_SECRET is missing (fail closed)
import { validatePayload } from "./validate.js";
import { verifyTurnstile } from "./turnstile.js";

export const ALLOWED_ORIGINS = [
  "https://quikreteqaplantvisit.com",
  "https://qa.quikreteqaplantvisit.com",
  "http://localhost:3000",
];
export const TURNSTILE_HOSTNAMES = ["quikreteqaplantvisit.com", "qa.quikreteqaplantvisit.com"];
export const TURNSTILE_ACTION = "qa_submit";   // the widget `action` the form sets

const RETRY_MESSAGE = "Verification failed. Reload the page and try again.";
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  return typeof real === "string" ? real.trim() : undefined;
}

function isEnforced(env) {
  return ["1", "true", "on"].includes(String(env.TURNSTILE_ENFORCE || "").toLowerCase());
}

/** Build the body Apps Script receives: client control fields out, our secret in. */
function forwardedBody(body, env) {
  const out = { ...body };
  delete out.form_secret;
  delete out.cf_turnstile_token;
  const secret = env.FORM_SECRET || env.SHARED_SECRET;
  if (secret) out.form_secret = secret;
  return out;
}

export function createHandler({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  return async function handler(req, res) {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") {
      return res.status(405).json({ status: "error", message: "Method not allowed" });
    }
    const appsScriptUrl = env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) {
      return res.status(500).json({ status: "error", message: "APPS_SCRIPT_URL env var not set" });
    }

    const enforce = isEnforced(env);
    const body = req.body;

    // Refused in BOTH modes: these are not form submissions, and forwarding them
    // in any shape makes a junk visit (a passthrough body with `passthrough`
    // stripped lands on the QA path; a non-object body becomes {}).
    if (!isPlainObject(body)) {
      log.warn("qa-submit refused: body is not a JSON object");
      return res.status(400).json({ status: "error", message: "request body must be a JSON object" });
    }
    if ("passthrough" in body) {
      log.warn("qa-submit refused: passthrough body");
      return res.status(400).json({ status: "error", message: "passthrough is not allowed" });
    }

    const schema = validatePayload(body);

    const token = body.cf_turnstile_token;
    const turnstile = await verifyTurnstile(typeof token === "string" ? token : "", {
      secret: env.TURNSTILE_SECRET,
      remoteip: clientIp(req),
      allowedHostnames: TURNSTILE_HOSTNAMES,
      expectedAction: TURNSTILE_ACTION,
      fetchImpl,
    });

    const plant = typeof body.plant === "string" ? body.plant.slice(0, 40) : "";
    const summary = `qa-submit enforce=${enforce ? "on" : "off"} schema=${schema.ok ? "ok" : `fail(${schema.status})`}`
      + ` turnstile=${turnstile.ok ? "ok" : turnstile.reason}`
      + ` test_mode=${body.test_mode === true} plant=${JSON.stringify(plant)}`;
    log.info(summary);

    if (enforce) {
      if (!schema.ok) return res.status(schema.status).json({ status: "error", message: schema.message });
      if (!turnstile.ok) {
        if (turnstile.reason === "not-configured") {
          return res.status(503).json({ status: "error", message: "Submission verification is not configured. Contact the QA admin." });
        }
        return res.status(403).json({ status: "error", message: RETRY_MESSAGE });
      }
    } else {
      if (!schema.ok) log.warn(`qa-submit would reject (${schema.status}): ${schema.message}`);
      if (!turnstile.ok) log.warn(`qa-submit would reject (403): turnstile ${turnstile.reason}`);
    }

    try {
      const response = await fetchImpl(appsScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwardedBody(body, env)),
      });
      const text = await response.text();
      const ok = response.ok;
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!json || typeof json !== "object") json = { data: json };
      if (!("status" in json)) json.status = ok ? "success" : "error";
      return res.status(ok ? 200 : 500).json(json);
    } catch (err) {
      log.error ? log.error(err) : log.warn(String(err));
      return res.status(500).json({ status: "error", message: "Proxy error: " + err.message });
    }
  };
}
