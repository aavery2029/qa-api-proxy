// api/submit.js

// Allow both prod + QA domains (and optional localhost for testing)
const ALLOWED_ORIGINS = [
  "https://quikreteqaplantvisit.com",
  "https://qa.quikreteqaplantvisit.com",
  "http://localhost:3000", // optional – remove if you don't want it
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // Ensure caches treat each origin separately
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ status: "error", message: "Method not allowed" });
  }

  const appsScriptUrl = process.env.APPS_SCRIPT_URL;
  if (!appsScriptUrl) {
    return res
      .status(500)
      .json({ status: "error", message: "APPS_SCRIPT_URL env var not set" });
  }

  try {
    const response = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    return res.status(response.status).json(json);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Proxy error: " + err.message });
  }
}
