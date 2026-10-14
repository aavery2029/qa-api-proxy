import test from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "../lib/validate.js";
import { goodPayload, PNG_1x1 } from "./fixtures.js";

function reject(body, status, pattern) {
  const v = validatePayload(body);
  assert.equal(v.ok, false, "expected rejection, got ok");
  assert.equal(v.status, status);
  assert.match(v.message, pattern);
}

test("accepts a v4 preview payload", () => {
  const v = validatePayload(goodPayload());
  assert.equal(v.ok, true);
});

test("accepts a payload without images or notes", () => {
  const body = goodPayload();
  delete body.images;
  delete body.report.notes;
  assert.equal(validatePayload(body).ok, true);
});

test("accepts a payload without test_mode (the promoted root form)", () => {
  const body = goodPayload();
  delete body.test_mode;
  delete body.cf_turnstile_token;
  assert.equal(validatePayload(body).ok, true);
});

test("rejects a non-object body", () => {
  reject(null, 400, /body/i);
  reject([1, 2], 400, /body/i);
  reject("text", 400, /body/i);
});

test("rejects a legacy payload with no report", () => {
  const body = goodPayload();
  delete body.report;
  reject(body, 400, /report/i);
});

test("rejects passthrough and client-supplied form_secret", () => {
  reject(goodPayload({ passthrough: true }), 400, /not allowed/i);
  reject(goodPayload({ form_secret: "x" }), 400, /not allowed/i);
});

test("rejects a body over the size cap", () => {
  const body = goodPayload({ daily_ops_comments: "x".repeat(4000) });
  body.images = Array.from({ length: 30 }, (_, i) => ({
    name: `p${i}.png`,
    data: "data:image/png;base64," + "A".repeat(145000),
    section: "operations",
    section_title: "Operations",
    caption: "",
  }));
  reject(body, 413, /too large/i);
});

test("rejects missing or malformed required fields", () => {
  reject(goodPayload({ plant: "" }), 400, /plant/i);
  reject(goodPayload({ email: "not-an-email" }), 400, /email/i);
  reject(goodPayload({ timestamp: "yesterday" }), 400, /timestamp/i);
  reject(goodPayload({ form_version: 1 }), 400, /form_version/i);
  reject(goodPayload({ test_mode: "yes" }), 400, /test_mode/i);
});

test("rejects report structure outside the Apps Script limits", () => {
  const tooManySections = goodPayload();
  tooManySections.report.sections = Array.from({ length: 21 }, (_, i) => ({
    id: `s${i}`, title: `S${i}`, questions: [],
  }));
  reject(tooManySections, 400, /sections/i);

  const tooManyQuestions = goodPayload();
  tooManyQuestions.report.sections[0].questions = Array.from({ length: 81 }, (_, i) => ({
    key: `q${i}`, label: "L", answer: "yes", comment: "", pass: "yes",
  }));
  reject(tooManyQuestions, 400, /questions/i);

  const badQuestion = goodPayload();
  badQuestion.report.sections[0].questions[0].comment = { nested: true };
  reject(badQuestion, 400, /comment/i);

  const longComment = goodPayload();
  longComment.report.sections[0].questions[0].comment = "x".repeat(5001);
  reject(longComment, 400, /comment/i);
});

test("rejects images that are not image data URLs or exceed the count", () => {
  const notImage = goodPayload();
  notImage.images[0].data = "data:text/html;base64,PHNjcmlwdD4=";
  reject(notImage, 400, /image/i);

  const badBase64 = goodPayload();
  badBase64.images[0].data = "data:image/png;base64,<script>";
  reject(badBase64, 400, /image/i);

  const tooMany = goodPayload();
  tooMany.images = Array.from({ length: 31 }, () => ({ name: "p.png", data: PNG_1x1, section: "", section_title: "", caption: "" }));
  reject(tooMany, 400, /image/i);
});

test("rejects unknown top-level keys whose value is not a short string", () => {
  reject(goodPayload({ anything_else: { a: 1 } }), 400, /anything_else/);
  reject(goodPayload({ anything_else: "x".repeat(5001) }), 400, /anything_else/);
  assert.equal(validatePayload(goodPayload({ anything_else: "fine" })).ok, true);
});

test("rejects a body nested too deeply instead of throwing", () => {
  let nest = [];
  for (let i = 0; i < 200000; i++) nest = [nest];
  reject(goodPayload({ nest }), 400, /nested/i);
});

test("rejects an oversized Turnstile token", () => {
  reject(goodPayload({ cf_turnstile_token: "t".repeat(2049) }), 400, /turnstile/i);
});
