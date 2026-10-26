// Vercel function entry point: POST /api/verify-code. All behavior lives in lib/relay.js
// so it can be tested offline.
import { createRelayHandler } from "../lib/relay.js";

export default createRelayHandler("verify_code", { env: process.env, fetchImpl: fetch, log: console });
