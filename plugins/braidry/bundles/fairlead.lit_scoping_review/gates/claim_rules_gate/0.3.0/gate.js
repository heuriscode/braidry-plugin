// --- gatekit 0.1.0 (JavaScript) --- embedded verbatim in every JS gate; tests/braids/test_gatekit.py checks it.
// Gate I/O protocol gate_io/0.1 (BRAIDS_SPEC §3.8). Node built-ins only, so a gate is one self-contained file.
// Every function matches gatekit.py byte for byte in what it returns.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PROTOCOL = "gate_io/0.1";
const EXIT = { pass: 0, fail: 1, warn: 2, skipped: 3 };

class NetworkUnavailable extends Error {}

function canonical(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new TypeError("gatekit.canonical: non-integer number");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(); // default sort compares UTF-16 code units
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  throw new TypeError("gatekit.canonical: unsupported type " + typeof value);
}

function fpRaw(buf) {
  return "raw:sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

function fpJcs(value) {
  return "jcs1:sha256:" + crypto.createHash("sha256").update(Buffer.from(canonical(value), "utf8")).digest("hex");
}

function pct(text, safe = "") {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/^[A-Za-z0-9\-._~]$/.test(ch) || (byte < 128 && safe.includes(ch))) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-z]{2,6});/g, (m, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

function asciiFold(text) {
  let t = text.normalize("NFKD").replace(/\p{M}/gu, "");
  t = t.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return t.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((x) => x).join(" ");
}

function normText(text) {
  let t = decodeEntities(text);
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/-[ \t]*\r?\n[ \t]*/g, "");
  return asciiFold(t);
}

function similarity(a0, b0) {
  const a = asciiFold(a0), b = asciiFold(b0);
  if (!a && !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  const m = Math.max(a.length, b.length);
  return Math.floor((100 * (m - prev[b.length])) / m);
}

async function fetchUrl(gateId, url) {
  const cassettes = process.env.FAIRLEAD_CASSETTES;
  let file = null;
  if (cassettes) {
    const name = fpJcs({ method: "GET", url }).split(":").pop() + ".json";
    file = path.join(cassettes, gateId, name);
    if (fs.existsSync(file)) {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      return [c.response.status, c.response.body];
    }
    if (process.env.FAIRLEAD_CASSETTES_RECORD !== "1") throw new Error("missing cassette for " + url);
  }
  let status, ctype, body;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "fairlead-" + gateId + "/0.1" }, signal: AbortSignal.timeout(30000) });
    status = resp.status;
    ctype = resp.headers.get("content-type") || "";
    body = await resp.text();
  } catch (err) {
    throw new NetworkUnavailable(new URL(url).hostname);
  }
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cassette = { gate_ref: gateId, request: { method: "GET", url }, response: { status, content_type: ctype, body } };
    fs.writeFileSync(file, JSON.stringify(cassette, null, 1) + "\n", "utf8");
  }
  return [status, body];
}

async function runInner(gateId, gateRef, check) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--out") {
    process.stderr.write("usage: gate --input <input.json> --out <result.json>\n");
    return 4;
  }
  const gateInput = JSON.parse(fs.readFileSync(args[1], "utf8"));
  if (gateInput.protocol !== PROTOCOL) {
    process.stderr.write("unsupported protocol\n");
    return 4;
  }
  const ports = (gateInput.target ? [gateInput.target] : []).concat(gateInput.extra_inputs || []);
  const raw = {};
  for (const port of ports) raw[port.path] = fs.readFileSync(port.path);
  const load = (port) => JSON.parse(raw[port.path].toString("utf8"));
  let status, checked, failed, evidence;
  try {
    [status, checked, failed, evidence] = await check(gateInput, load);
  } catch (err) {
    if (!(err instanceof NetworkUnavailable)) throw err;
    [status, checked, failed] = ["skipped", 0, 0];
    evidence = [{ ref: "network", detail: "network unavailable: " + err.message }];
  }
  const result = {
    gate_id: gateId, gate_ref: gateRef, status, checked, failed,
    script_fingerprint: fpRaw(fs.readFileSync(__filename)),
    input_fingerprints: ports.map((p) => fpRaw(raw[p.path])),
    evidence: evidence.slice(0, 50),
  };
  fs.writeFileSync(args[3], canonical(result), "utf8");
  return EXIT[status];
}

function run(gateId, gateRef, check) {
  runInner(gateId, gateRef, check).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(String((err && err.stack) || err) + "\n");
      process.exit(4);
    },
  );
}
// --- end gatekit ---

const GATE_ID = "claim_rules_gate";
const GATE_REF = "claim_rules_gate@0.3.0";
const ORDER = ["record_only_support", "absence_on_abstract", "unscoped_none"];
const ABSENCE = ["does not", "do not", "did not", "no evidence", "not report", "not compare", "not examine",
  "not address", "fails to", "omits"];
const SCARCITY = ["no study", "no studies", "none of the", "few studies", "little evidence", "thin", "rarely", "scarce",
  "no research"];
const SCOPE = ["screened", "searched", "read in full", "included in this review"];
const BRACKET = /[ \t]*\[([^\[\]]+)\]/g;
const MARKER = /^[A-Za-z](?=[A-Za-z0-9_.:-]*[0-9])[A-Za-z0-9_.:-]*(?:,\s*(?:p\.\s*[0-9]+|pp\.\s*[0-9]+-[0-9]+))?$/;
const POOL_NUMBER =
  /(?:^|[^0-9a-z,.])(?:[0-9][0-9,]* (?:works|studies|sources|papers|records|articles)|of the (?!(?:19|20)[0-9]{2}(?![0-9]|,[0-9]))[0-9][0-9,]*)(?:$|[^0-9a-z])/;

function firstPhrase(folded, phrases) {
  const padded = " " + folded + " ";
  for (const p of phrases) if (padded.includes(" " + p + " ")) return p;
  return null;
}

function stripMarkers(text) {
  return text.replace(BRACKET, (whole, inner) =>
    inner.split(";").every((x) => MARKER.test(x.trim())) ? "" : whole);
}

function unscopedPhrase(text) {
  for (const sentence of stripMarkers(text).split(/[.!?]+(?:[ \t\r\n]+|$)/)) {
    const folded = asciiFold(sentence);
    const phrase = firstPhrase(folded, SCARCITY);
    if (phrase === null) continue;
    if (POOL_NUMBER.test(" " + folded + " ") || firstPhrase(folded, SCOPE)) continue;
    return phrase;
  }
  return null;
}

function check(gateInput, load) {
  const draft = load(gateInput.target);
  const register = load(gateInput.extra_inputs[0]);
  const levels = {};
  for (const e of register.items || []) levels[e.source_id] = e.read_level;
  for (const r of draft.references || []) levels[r.source_id] = r.read_level;
  const counts = {};
  for (const k of ORDER) counts[k] = 0;
  const evidence = [];
  let checked = 0;
  const flag = (outcome, ref, phrase) => {
    counts[outcome] += 1;
    evidence.push({ ref, detail: outcome + (phrase ? "; phrase=" + phrase : "") });
  };
  (draft.sections || []).forEach((section, si) => {
    (section.paragraphs || []).forEach((para, pi) => {
      checked += 1;
      let phrase = unscopedPhrase(para.text || "");
      if (phrase) flag("unscoped_none", (si + 1) + "." + (pi + 1), phrase);
      for (const claim of para.claims || []) {
        checked += 1;
        const cid = claim.claim_id;
        const support = claim.support || [];
        const supLevels = support.map((s) => levels[s.source_id]);
        if (claim.kind === "evidence" && support.length && supLevels.every((v) => v === "record")) {
          flag("record_only_support", cid);
        }
        if (support.length && supLevels.every((v) => v === "abstract" || v === "record")) {
          phrase = firstPhrase(asciiFold(claim.text || ""), ABSENCE);
          if (phrase) flag("absence_on_abstract", cid, phrase);
        }
        phrase = unscopedPhrase(claim.text || "");
        if (phrase) flag("unscoped_none", cid, phrase);
      }
    });
  });
  const failed = counts.record_only_support;
  const any = ORDER.some((k) => counts[k]);
  const status = failed ? "fail" : any ? "warn" : "pass";
  const summary = { ref: "summary", detail: ORDER.map((k) => k + "=" + counts[k]).join(" ") };
  return [status, checked, failed, [summary].concat(evidence)];
}

run(GATE_ID, GATE_REF, check);
