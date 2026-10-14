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
 * @param {string} [opts.expectedAction]  the widget `action` the form sets; a token
 *                                         issued for another action is refused
 * @param {number} [opts.timeoutMs]       give up on siteverify after this long
 *                                         (a hung upstream must not hang the form)
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifyTurnstile(token, {
  secret, remoteip, allowedHostnames, expectedAction, timeoutMs = 5000, fetchImpl = fetch,
}) {
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
      signal: AbortSignal.timeout(timeoutMs),
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
  if (expectedAction && result.action !== expectedAction) {
    return { ok: false, reason: "action-mismatch" };
  }
  return { ok: true };
}
