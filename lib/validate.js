// Schema validation for QA Plant Visit submissions.
// Mirrors the limits the Apps Script applies (MAX_SECTIONS 20, MAX_QUESTIONS 80,
// MAX_FIELD_CHARS 5000, MAX_PHOTOS_ACCEPTED 30) so anything the proxy forwards is
// something the script would have accepted anyway. Question keys are NOT
// enumerated on purpose: the form owns the question list (v4 design), so the
// proxy checks shape and size, not vocabulary.

export const MAX_BODY_CHARS = 4_200_000;   // the form refuses to send more than this
const MAX_SECTIONS = 20;
const MAX_QUESTIONS = 80;
const MAX_FIELD_CHARS = 5000;
const MAX_IMAGES = 30;
const MAX_TOP_LEVEL_KEYS = 300;
const MAX_TOKEN_CHARS = 2048;              // Turnstile documented maximum

const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|gif|webp);base64,[A-Za-z0-9+/]+=*$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Reject extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Reject(400, `${name} is required`);
    return;
  }
  if (typeof value !== "string") throw new Reject(400, `${name} must be a string`);
  if (required && value.trim() === "") throw new Reject(400, `${name} is required`);
  if (value.length > max) throw new Reject(400, `${name} is too long (max ${max} characters)`);
}

function checkQuestion(q, where) {
  if (!isPlainObject(q)) throw new Reject(400, `${where} must be an object`);
  str(q.key, `${where}.key`, 60, { required: true });
  str(q.label, `${where}.label`, 300);
  str(q.answer, `${where}.answer`, 60);
  str(q.comment, `${where}.comment`, MAX_FIELD_CHARS);
  str(q.pass, `${where}.pass`, 60);
  if (q.extra !== undefined) {
    if (!Array.isArray(q.extra) || q.extra.length > 5) throw new Reject(400, `${where}.extra must be a list of at most 5 items`);
    q.extra.forEach((x, i) => {
      if (!isPlainObject(x)) throw new Reject(400, `${where}.extra[${i}] must be an object`);
      str(x.label, `${where}.extra[${i}].label`, 120);
      str(x.value, `${where}.extra[${i}].value`, 500);
    });
  }
}

function checkReport(report) {
  if (!isPlainObject(report)) throw new Reject(400, "report is required");
  if (!Array.isArray(report.sections) || report.sections.length === 0) throw new Reject(400, "report.sections is required");
  if (report.sections.length > MAX_SECTIONS) throw new Reject(400, `report has too many sections (max ${MAX_SECTIONS})`);
  let questionCount = 0;
  report.sections.forEach((s, i) => {
    const where = `report.sections[${i}]`;
    if (!isPlainObject(s)) throw new Reject(400, `${where} must be an object`);
    str(s.id, `${where}.id`, 60);
    str(s.title, `${where}.title`, 120);
    if (s.photo_count !== undefined && !(Number.isInteger(s.photo_count) && s.photo_count >= 0)) {
      throw new Reject(400, `${where}.photo_count must be a whole number`);
    }
    if (!Array.isArray(s.questions)) throw new Reject(400, `${where}.questions must be a list`);
    questionCount += s.questions.length;
    if (questionCount > MAX_QUESTIONS) throw new Reject(400, `report has too many questions (max ${MAX_QUESTIONS})`);
    s.questions.forEach((q, j) => checkQuestion(q, `${where}.questions[${j}]`));
  });
  if (report.notes !== undefined) {
    if (!Array.isArray(report.notes) || report.notes.length > 10) throw new Reject(400, "report.notes must be a list of at most 10 items");
    report.notes.forEach((n, i) => {
      if (!isPlainObject(n)) throw new Reject(400, `report.notes[${i}] must be an object`);
      str(n.key, `report.notes[${i}].key`, 60);
      str(n.label, `report.notes[${i}].label`, 120);
      str(n.value, `report.notes[${i}].value`, MAX_FIELD_CHARS);
    });
  }
}

// A photo's file name is the phone's own (the form puts no limit on it), and the
// Apps Script clips it to 80 characters anyway. So a long name is shortened here,
// keeping its extension, instead of refusing the whole report (2026-10-23).
// Changes body.images[i].name in place: the forwarded body is built from it.
const MAX_PHOTO_NAME_CHARS = 80;

export function shortPhotoName(name) {
  if (name.length <= MAX_PHOTO_NAME_CHARS) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  return name.slice(0, MAX_PHOTO_NAME_CHARS - ext.length) + ext;
}

function checkImages(images) {
  if (images === undefined) return;
  if (!Array.isArray(images)) throw new Reject(400, "images must be a list");
  if (images.length > MAX_IMAGES) throw new Reject(400, `too many images (max ${MAX_IMAGES})`);
  images.forEach((img, i) => {
    const where = `images[${i}]`;
    if (!isPlainObject(img)) throw new Reject(400, `${where} must be an object`);
    if (typeof img.data !== "string" || !IMAGE_DATA_URL.test(img.data)) {
      throw new Reject(400, `${where} is not an image (expected a base64 image data URL)`);
    }
    str(img.name, `${where}.name`, Infinity);
    if (typeof img.name === "string") img.name = shortPhotoName(img.name);
    str(img.section, `${where}.section`, 60);
    str(img.section_title, `${where}.section_title`, 120);
    str(img.caption, `${where}.caption`, 120);
  });
}

const TYPED_KEYS = new Set([
  "plant", "email", "timestamp", "form_version", "test_mode", "report", "images", "cf_turnstile_token", "session",
]);
const MAX_SESSION_CHARS = 1024;            // the signed sign-in session (checked by Apps Script)

/**
 * Validate a submission body. Returns {ok:true} or {ok:false, status, message}.
 * Never throws for bad input; a thrown error here is a bug in the validator.
 */
export function validatePayload(body) {
  try {
    if (!isPlainObject(body)) throw new Reject(400, "request body must be a JSON object");

    // Size first: everything below walks the structure, and the form itself
    // refuses to send more than MAX_BODY_CHARS, so a bigger body is not the form.
    let serialized;
    try {
      serialized = JSON.stringify(body);
    } catch {
      // Hundreds of thousands of nested arrays parse fine but blow the stack here.
      throw new Reject(400, "request body is nested too deeply");
    }
    if (serialized.length > MAX_BODY_CHARS) throw new Reject(413, "report is too large");

    for (const key of ["passthrough", "form_secret"]) {
      if (key in body) throw new Reject(400, `${key} is not allowed`);
    }

    const keys = Object.keys(body);
    if (keys.length > MAX_TOP_LEVEL_KEYS) throw new Reject(400, "too many fields");

    str(body.plant, "plant", 120, { required: true });
    str(body.email, "email", 254, { required: true });
    if (!EMAIL.test(body.email)) throw new Reject(400, "email is not a valid address");
    str(body.timestamp, "timestamp", 40, { required: true });
    if (Number.isNaN(Date.parse(body.timestamp))) throw new Reject(400, "timestamp is not a valid date");
    if (body.form_version !== 2) throw new Reject(400, "form_version must be 2");
    if (body.test_mode !== undefined && body.test_mode !== true) throw new Reject(400, "test_mode must be true when present");
    str(body.cf_turnstile_token, "cf_turnstile_token", MAX_TOKEN_CHARS);
    str(body.session, "session", MAX_SESSION_CHARS);

    checkReport(body.report);
    checkImages(body.images);

    // Everything else is a form field: a string, bounded like a comment.
    for (const key of keys) {
      if (TYPED_KEYS.has(key)) continue;
      str(body[key], key, MAX_FIELD_CHARS);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Reject) return { ok: false, status: err.status, message: err.message };
    throw err;
  }
}
