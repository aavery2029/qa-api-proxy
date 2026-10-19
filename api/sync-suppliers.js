// Vercel function entry point: POST /api/sync-suppliers. All behavior lives in lib/relay.js
// so it can be tested offline.
import { createRelayHandler } from "../lib/relay.js";

export default createRelayHandler("sync_suppliers", { env: process.env, fetchImpl: fetch, log: console });
