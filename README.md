# qa-api-proxy

Vercel function in front of the QA Plant Visit Apps Script. The browser form at
quikreteqaplantvisit.com POSTs a JSON report to `/api/submit`; this proxy checks
it and forwards it to the Apps Script `/exec` URL. Sign-in and the supplier
list go through four more relays (see below).

## What it checks (since 2026-10-13)

| Check | Where | Fails with |
|---|---|---|
| Body shape and size (same limits as the Apps Script: 20 sections, 80 questions, 5,000 chars per field, 30 images, 4.2 M chars total) | `lib/validate.js` | 400 / 413 |
| Cloudflare Turnstile token (`cf_turnstile_token`), verified with siteverify, hostname must be ours | `lib/turnstile.js` | 403 |
| Shared secret injected server-side as `form_secret` so the Apps Script can fail closed | `lib/handler.js` | n/a |

A client-supplied `form_secret` and the Turnstile token are never forwarded.
Two things are refused in BOTH modes because forwarding them in any shape would
create a junk visit: a body that is not a JSON object, and a body carrying
`passthrough` (the old Apps Script email relay; nothing calls it).

Siteverify is given 5 seconds; a hung Cloudflare counts as unreachable so a
stalled upstream never stalls the form. The token's widget `action` must be
`qa_submit`, the value the form sets.

## Environment variables (Vercel project settings)

| Variable | Purpose |
|---|---|
| `APPS_SCRIPT_URL` | the Apps Script web app `/exec` URL (existing) |
| `FORM_SECRET` | shared secret injected into every forwarded body; falls back to the older `SHARED_SECRET` |
| `TURNSTILE_SECRET` | Turnstile widget secret key |
| `TURNSTILE_ENFORCE` | unset or `0`: log-only, every request is forwarded as before. `1`: reject failures |

Every request writes one line to the runtime log, for example
`qa-submit enforce=off schema=ok turnstile=missing-token test_mode=true plant="705 Manvel"`,
plus a `would reject` warning in log-only mode.

## Rollout order (zero downtime)

1. Deploy with `TURNSTILE_ENFORCE` unset. Behavior is unchanged except for the log line.
2. Put the widget site key in the form (`TURNSTILE_SITE_KEY`), set `TURNSTILE_SECRET` here, and watch the log show `turnstile=ok` on a test submission.
3. Promote the form that sends tokens to the root of the site.
4. Set `TURNSTILE_ENFORCE=1` and `FORM_SECRET` here.
5. Set the same `FORM_SECRET` as a Script Property in the Apps Script project. From then on the script accepts only requests that came through this proxy.

Enforcement on without `TURNSTILE_SECRET` fails closed (503) on purpose.

## Sign-in and supplier relays (since 2026-10-19)

Four more routes relay to the same Apps Script `/exec` (needs Apps Script v4.3).
They live in `lib/relay.js`; every check of a code, a session or the sync
secret happens in Apps Script, so this repo holds no roster, no supplier list,
no plant data and no new secret.

| Route | Caller | Sends on | Proxy checks |
|---|---|---|---|
| `POST /api/request-code` | the form | `email` | email shape; Turnstile ALWAYS enforced (action `qa_signin`, 403 on failure, 503 if `TURNSTILE_SECRET` is missing) |
| `POST /api/verify-code` | the form | `email`, `code` | 6 digits |
| `POST /api/suppliers` | the form | `session` | session shape |
| `POST /api/sync-suppliers` | Dashboard1 monthly job | `sync_secret`, `suppliers[]`, `plants[]`, `dry_run` | sizes and shapes (500 suppliers, 2,000 rows) |

The body sent on is rebuilt from that whitelist, plus `action`, the form secret,
`passthrough: true` and `test_mode: true`. The passthrough marker is a tripwire:
a script older than v4.3 refuses such a body (no visit, no email), and v4.3
accepts an action only with it; both proxy versions refuse a client body that
carries passthrough, so only these relays can send one. The submit
route strips `action`, `turnstile_verified` and `sync_secret`, so a submission
can never reach these actions. Logs name the route, the Turnstile verdict, an
email's domain and list sizes; never a code, a session, a secret or a full address.

**Deploy order:** paste Apps Script v4.3 first, then push this repo.

## Tests

```
npm test
```

Node's built-in runner, no dependencies, no network. The handler is tested with
an injected `fetch`, so the tests cover both rollout modes end to end.
