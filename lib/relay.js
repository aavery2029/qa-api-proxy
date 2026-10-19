// Sign-in and supplier relays (2026-10-19): browser form (or the Dashboard1
// monthly job) -> this function -> Apps Script. The proxy holds no roster, no
// supplier list and no secrets of its own beyond what submit.js already uses:
// every check of a code, a session or the sync secret happens in Apps Script.
//
//   POST /api/request-code   {email, cf_turnstile_token}  Turnstile ALWAYS enforced
//   POST /api/verify-code    {email, code}
//   POST /api/suppliers      {session}
//   POST /api/sync-suppliers {sync_secret, suppliers[], plants[], dry_run?}  (Dashboard1)
//
// The body sent on is REBUILT from a per route whitelist, so nothing else the
// caller sends (form_secret, passthrough, another action, turnstile_verified)
// ever reaches the script. Every relayed body carries passthrough: true (see
// below: a script before v4.3 then refuses it instead of making a visit) and
// test_mode: true (a second net: had it become a visit, QA Admin alone gets it).
import { verifyTurnstile } from "./turnstile.js";
import { setCorsHeaders, clientIp, TURNSTILE_HOSTNAMES } from "./handler.js";

export const SIGNIN_TURNSTILE_ACTION = "qa_signin";   // the widget `action` the form sets for sign-in

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
const MAX_TOKEN_CHARS = 2048;
const MAX_SYNC_CHARS = 600_000;
const RETRY_MESSAGE = "Verification failed. Reload the page and try again.";

class Reject extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(value, name, max, { required = true, min = 0 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Reject(400, `${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Reject(400, `${name} must be a string`);
  if (value.length > max) throw new Reject(400, `${name} is too long`);
  if (value.length < min) throw new Reject(400, `${name} is too short`);
  return value;
}

function email(value) {
  const e = str(value, "email", 254).trim();
  if (!EMAIL.test(e)) throw new Reject(400, "Enter your full email address.");
  return e;
}

function list(value, name, max, item) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Reject(400, `${name} must be a list`);
  if (value.length > max) throw new Reject(413, `${name} has too many items (max ${max})`);
  return value.map((x, i) => {
    if (!isPlainObject(x)) throw new Reject(400, `${name}[${i}] must be an object`);
    return item(x, `${name}[${i}]`);
  });
}

// Per route: which fields go on to Apps Script, checked for shape and size.
export const ROUTES = {
  request_code: {
    turnstile: true,
    build: (b) => ({ email: email(b.email) }),
  },
  verify_code: {
    build: (b) => {
      const code = String(str(b.code, "code", 20)).replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) throw new Reject(400, "Enter the 6 digit code from the email.");
      return { email: email(b.email), code };
    },
  },
  suppliers: {
    build: (b) => {
      const session = str(b.session, "session", 1024);
      if (!SESSION.test(session)) throw new Reject(400, "session is not valid");
      return { session };
    },
  },
  sync_suppliers: {
    maxChars: MAX_SYNC_CHARS,
    build: (b) => {
      const out = {
        sync_secret: str(b.sync_secret, "sync_secret", 256, { min: 16 }),
        suppliers: list(b.suppliers, "suppliers", 500, (x, w) => ({
          material: str(x.material, `${w}.material`, 40),
          supplier: str(x.supplier, `${w}.supplier`, 80),
        })),
        plants: list(b.plants, "plants", 2000, (x, w) => {
          const row = {
            plant: str(String(x.plant ?? ""), `${w}.plant`, 12),
            slot: str(x.slot, `${w}.slot`, 20),
            material: str(x.material, `${w}.material`, 40),
            supplier: str(x.supplier, `${w}.supplier`, 80, { required: false }) ?? "",
          };
          if (x.receipts !== undefined) {
            if (typeof x.receipts !== "number" || !Number.isFinite(x.receipts) || x.receipts < 0) throw new Reject(400, `${w}.receipts must be a number`);
            row.receipts = x.receipts;
          }
          return row;
        }),
      };
      if (b.dry_run !== undefined) {
        if (typeof b.dry_run !== "boolean") throw new Reject(400, "dry_run must be true or false");
        out.dry_run = b.dry_run;
      }
      return out;
    },
  },
};

function domainOf(e) {
  const at = typeof e === "string" ? e.lastIndexOf("@") : -1;
  return at > 0 ? e.slice(at + 1, at + 61).toLowerCase() : "";
}

export function createRelayHandler(action, { env = process.env, fetchImpl = fetch, log = console } = {}) {
  const route = ROUTES[action];
  if (!route) throw new Error("unknown relay action " + action);

  return async function relay(req, res) {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ status: "error", message: "Method not allowed" });
    const appsScriptUrl = env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) return res.status(500).json({ status: "error", message: "APPS_SCRIPT_URL env var not set" });

    const body = req.body;
    let fields;
    try {
      if (!isPlainObject(body)) throw new Reject(400, "request body must be a JSON object");
      let size;
      try { size = JSON.stringify(body).length; } catch { throw new Reject(400, "request body is nested too deeply"); }
      if (size > (route.maxChars || 20_000)) throw new Reject(413, "request is too large");
      fields = route.build(body);
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      log.warn(`qa-relay action=${action} refused (${err.status}): ${err.message}`);
      return res.status(err.status).json({ status: "error", message: err.message });
    }

    // passthrough: true is a tripwire for the deploy window. A script before
    // v4.3 refuses any passthrough body that lacks its secret (no visit, no
    // email); v4.3 accepts an action only WITH it. Both proxy versions refuse
    // a client body carrying passthrough, so only these relays can send one.
    const forwarded = { action, ...fields, passthrough: true, test_mode: true };
    let verdict = "";
    if (route.turnstile) {
      // New route, no older callers: enforced from day one, whatever TURNSTILE_ENFORCE says
      const token = typeof body.cf_turnstile_token === "string" ? body.cf_turnstile_token.slice(0, MAX_TOKEN_CHARS) : "";
      const ts = await verifyTurnstile(token, {
        secret: env.TURNSTILE_SECRET,
        remoteip: clientIp(req),
        allowedHostnames: TURNSTILE_HOSTNAMES,
        expectedAction: SIGNIN_TURNSTILE_ACTION,
        fetchImpl,
      });
      verdict = ` turnstile=${ts.ok ? "ok" : ts.reason}`;
      if (!ts.ok) {
        const clientReason = typeof body.cf_turnstile_error === "string" ? ` client=${JSON.stringify(body.cf_turnstile_error.slice(0, 80))}` : "";
        log.warn(`qa-relay action=${action} refused${verdict}${clientReason}`);
        if (ts.reason === "not-configured") {
          return res.status(503).json({ status: "error", message: "Sign in verification is not configured. Contact the QA admin." });
        }
        return res.status(403).json({ status: "error", message: RETRY_MESSAGE });
      }
      forwarded.turnstile_verified = true;
    }
    const secret = env.FORM_SECRET || env.SHARED_SECRET;
    if (secret) forwarded.form_secret = secret;

    // Logged: the route, the verdict, an email's domain, list sizes. Never a
    // code, a session, a secret or a full address.
    const detail = fields.email ? ` domain=${JSON.stringify(domainOf(fields.email))}` : "";
    const counts = action === "sync_suppliers"
      ? ` suppliers=${fields.suppliers.length} plants=${fields.plants.length} dry_run=${fields.dry_run === true}` : "";
    log.info(`qa-relay action=${action}${verdict}${detail}${counts}`);

    try {
      const response = await fetchImpl(appsScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwarded),
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!isPlainObject(json)) {
        // A Google sign-in page or an HTML error: never hand that to the form
        log.warn(`qa-relay action=${action} non-JSON reply (${response.status})`);
        return res.status(502).json({ status: "error", message: "The QA server did not answer. Try again in a minute." });
      }
      if (!("status" in json)) json.status = response.ok ? "success" : "error";
      return res.status(response.ok ? 200 : 502).json(json);
    } catch (err) {
      log.error ? log.error(err) : log.warn(String(err));
      return res.status(502).json({ status: "error", message: "The QA server did not answer. Try again in a minute." });
    }
  };
}
