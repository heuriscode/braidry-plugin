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

const GATE_ID = "quote_gate";
const GATE_REF = "quote_gate@0.2.0";
const ORDER = ["match", "not_in_abstract", "unverifiable", "no_match", "quote_on_record_read"];
const FRAGMENT_SPLIT = /\[\.\.\.\]|\.\.\.|…/;
const MIN_FRAGMENT = 6;

function cleanDoi(value) {
  if (typeof value !== "string") return null;
  let low = value.trim().toLowerCase();
  for (const prefix of ["https://doi.org/", "http://dx.doi.org/", "doi:"]) {
    if (low.startsWith(prefix)) {
      low = low.slice(prefix.length);
      break;
    }
  }
  return low || null;
}

function parseJson(body) {
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (err) {
    return {};
  }
}

function rebuildAbstract(index) {
  if (index === null || typeof index !== "object" || Array.isArray(index)) return "";
  const slots = new Map();
  for (const word of Object.keys(index)) for (const pos of index[word]) slots.set(pos, word);
  return [...slots.keys()].sort((a, b) => a - b).map((p) => slots.get(p)).join(" ");
}

async function lookupText(doi, arxivId) {
  if (doi) {
    let [status, body] = await fetchUrl(GATE_ID, "https://api.crossref.org/works/" + pct(doi, "/"));
    let title = "", abstract = "";
    if (status === 200) {
      const message = parseJson(body).message || {};
      const titles = message.title || [];
      title = titles.length && typeof titles[0] === "string" ? titles[0] : "";
      abstract = message.abstract || "";
    }
    if (!abstract.trim()) {
      [status, body] = await fetchUrl(GATE_ID, "https://api.openalex.org/works/doi:" + pct(doi, "/"));
      if (status === 200) abstract = rebuildAbstract(parseJson(body).abstract_inverted_index);
    }
    if (abstract.trim()) return title + " " + abstract;
  }
  if (arxivId) {
    const [status, body] = await fetchUrl(GATE_ID, "https://export.arxiv.org/api/query?id_list=" + pct(arxivId));
    if (status === 200) {
      const m = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(body);
      if (m && m[1].trim()) return m[1];
    }
  }
  return null;
}

function hasCheckableFragment(quote) {
  return quote.split(FRAGMENT_SPLIT).some((f) => normText(f).length >= MIN_FRAGMENT);
}

function quoteMatches(quote, text) {
  const haystack = normText(text);
  for (const fragment of quote.split(FRAGMENT_SPLIT)) {
    const needle = normText(fragment);
    if (needle.length >= MIN_FRAGMENT && !haystack.includes(needle)) return false;
  }
  return true;
}

function collect(contract, target, registerById) {
  const out = [];
  const add = (sourceId, quote, level, doi) => {
    if (typeof quote === "string" && quote.trim()) {
      const reg = registerById.get(sourceId) || {};
      const loc = reg.locator || {};
      out.push([sourceId, quote, level || reg.read_level || "abstract",
        cleanDoi(doi || loc.doi), loc.arxiv_id || null]);
    }
  };
  if (contract === "evidence_table") {
    for (const row of target.rows || [])
      for (const finding of row.key_findings || [])
        add(row.source_id, (finding.anchor || {}).quote, row.read_level, null);
  } else if (contract === "draft") {
    const refs = new Map((target.references || []).map((r) => [r.source_id, r]));
    for (const section of target.sections || [])
      for (const para of section.paragraphs || [])
        for (const claim of para.claims || [])
          for (const sup of claim.support || []) {
            const ref = refs.get(sup.source_id) || {};
            add(sup.source_id, (sup.anchor || {}).quote, ref.read_level, ref.doi);
          }
  } else {
    throw new Error("quote_gate: unsupported target contract " + contract);
  }
  return out;
}

async function check(gateInput, load) {
  const targetPort = gateInput.target;
  const extra = gateInput.extra_inputs || [];
  const register = extra.length ? load(extra[0]) : {};
  const registerById = new Map((register.items || []).map((i) => [i.source_id, i]));
  const quotes = collect(targetPort.contract, load(targetPort), registerById);
  const counts = {};
  for (const k of ORDER) counts[k] = 0;
  const seen = new Map();
  const texts = new Map();
  const items = [];
  for (const [sourceId, quote, level, doi, arxivId] of quotes) {
    seen.set(sourceId, (seen.get(sourceId) || 0) + 1);
    let outcome;
    if (level === "record") {
      outcome = "quote_on_record_read";
    } else if (!hasCheckableFragment(quote)) {
      outcome = "unverifiable";
    } else {
      if (!texts.has(sourceId)) texts.set(sourceId, await lookupText(doi, arxivId));
      const text = texts.get(sourceId);
      if (text === null) outcome = "unverifiable";
      else if (quoteMatches(quote, text)) outcome = "match";
      else if (level === "full_text" || level === "full_text_partial") outcome = "not_in_abstract";
      else outcome = "no_match";
    }
    counts[outcome] += 1;
    if (outcome !== "match")
      items.push({ ref: sourceId + "#" + seen.get(sourceId), detail: outcome + "; read_level=" + level });
  }
  const failed = counts.no_match + counts.quote_on_record_read;
  let status;
  if (failed) status = "fail";
  else if (counts.not_in_abstract || counts.unverifiable) status = "warn";
  else status = "pass";
  const summary = { ref: "summary", detail: ORDER.map((k) => k + "=" + counts[k]).join(" ") };
  return [status, quotes.length, failed, [summary, ...items]];
}

run(GATE_ID, GATE_REF, check);
