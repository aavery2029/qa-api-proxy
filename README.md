# qa-api-proxy

Vercel function in front of the QA Plant Visit Apps Script. The browser form at
quikreteqaplantvisit.com POSTs a JSON report to `/api/submit`; this proxy checks
it and forwards it to the Apps Script `/exec` URL.

## What it checks (since 2026-10-13)

| Check | Where | Fails with |
|---|---|---|
| Body shape and size (same limits as the Apps Script: 20 sections, 80 questions, 5,000 chars per field, 30 images, 4.2 M chars total) | `lib/validate.js` | 400 / 413 |
| Cloudflare Turnstile token (`cf_turnstile_token`), verified with siteverify, hostname must be ours | `lib/turnstile.js` | 403 |
| Shared secret injected server-side as `form_secret` so the Apps Script can fail closed | `lib/handler.js` | n/a |

Client-supplied `passthrough`, `form_secret` and the Turnstile token are never
forwarded.

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

## Tests

```
npm test
```

Node's built-in runner, no dependencies, no network. The handler is tested with
an injected `fetch`, so the tests cover both rollout modes end to end.
