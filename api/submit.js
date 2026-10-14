// Vercel function entry point. All behavior lives in lib/handler.js so it can be
// tested offline; see that file for the TURNSTILE_ENFORCE rollout switch.
import { createHandler } from "../lib/handler.js";

export default createHandler({ env: process.env, fetchImpl: fetch, log: console });
