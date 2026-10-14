// Cloudflare Turnstile server-side validation (siteverify).
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// Tokens live 300 s and are single use; a replay comes back as timeout-or-duplicate.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * @param {string} token      the cf_turnstile_token from the browser
 * @param {object} opts
 * @param {string} opts.secret            widget secret key (Vercel env TURNSTILE_SECRET)
 * @param {string} [opts.remoteip]        visitor IP, forwarded to Cloudflare when known
 * @param {string[]} opts.allowedHostnames hostnames the widget may be solved on
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifyTurnstile(token, { secret, remoteip, allowedHostnames, fetchImpl = fetch }) {
  if (!token) return { ok: false, reason: "missing-token" };
  if (!secret) return { ok: false, reason: "not-configured" };

  const payload = { secret, response: token };
  if (remoteip) payload.remoteip = remoteip;

  let result;
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    result = await res.json();
  } catch {
    return { ok: false, reason: "siteverify-unreachable" };
  }

  if (!result || result.success !== true) {
    const codes = Array.isArray(result?.["error-codes"]) ? result["error-codes"] : [];
    return { ok: false, reason: codes.join(",") || "verification-failed" };
  }
  if (allowedHostnames?.length && !allowedHostnames.includes(result.hostname)) {
    return { ok: false, reason: "hostname-mismatch" };
  }
  return { ok: true };
}
