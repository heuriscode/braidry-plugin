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

const GATE_ID = "cite_gate";
const GATE_REF = "cite_gate@0.5.0";
const ORDER = ["verified", "possible", "unverified_url", "lookup_error", "not_found", "doi_not_found",
  "doi_title_mismatch", "unresolved_citation", "unsupported_claim", "no_references",
  "reference_not_in_register", "duplicate_ref_id", "duplicate_register_id", "unparsed_marker"];
const FAIL = new Set(["unresolved_citation", "unsupported_claim", "no_references", "reference_not_in_register",
  "duplicate_ref_id", "duplicate_register_id", "doi_title_mismatch", "doi_not_found", "not_found"]);
const WARN = new Set(["possible", "unverified_url", "lookup_error", "unparsed_marker"]);
const LEADING_ID = /^[A-Za-z][A-Za-z0-9_.:-]*/;
const MARKER = /^([A-Za-z](?=[A-Za-z0-9_.:-]*[0-9])[A-Za-z0-9_.:-]*)(?:,\s*(?:p\.\s*[0-9]+|pp\.\s*[0-9]+[-–][0-9]+))?$/;

function markers(text) {
  const out = [];
  let unparsed = 0;
  for (const m of text.matchAll(/\[([^\[\]]+)\]/g)) {
    const lead = LEADING_ID.exec(m[1].trim());
    if (!lead || !/[0-9]/.test(lead[0])) continue;
    const found = m[1].split(";").map((p) => MARKER.exec(p.trim()));
    const ids = found.filter((f) => f).map((f) => f[1]);
    if (!found.every((f) => f)) {
      unparsed += 1;
      if (!found[0]) ids.unshift(lead[0]);
    }
    for (const sid of ids) if (!out.includes(sid)) out.push(sid);
  }
  return [out, unparsed];
}

function cleanDoi(doi) {
  let d = doi.trim().toLowerCase();
  for (const prefix of ["https://doi.org/", "http://dx.doi.org/", "doi:"]) {
    if (d.startsWith(prefix)) {
      d = d.slice(prefix.length);
      break;
    }
  }
  return d;
}

function arxivRecords(body) {
  // [title, doi, venue] for each entry of an arXiv API feed, in feed order; doi is the entry's arxiv:doi.
  const out = [];
  for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[1]);
    if (!t) continue;
    const d = /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(m[1]);
    out.push([decodeEntities(t[1]), d ? d[1].trim() : "", "arXiv"]);
  }
  return out;
}

function crossrefRecord(item) {
  // [title, doi, venue] of a Crossref work: its first title, its DOI and its first container title.
  const titles = item.title || [];
  const venues = item["container-title"] || [];
  return [titles.length ? titles[0] : "", item.DOI || "", venues.length ? venues[0] : ""];
}

function bestOf(title, records) {
  // The record whose title is most similar to title (the first of equals), and that similarity.
  let best = 0, found = ["", "", ""];
  for (const r of records) {
    const s = similarity(title, r[0]);
    if (s > best || !found[0]) {
      best = s;
      found = r;
    }
  }
  return [best, found];
}

const NONE = ["", "", ""];
// Whitespace, spelled out so both runtimes collapse the same characters.
const WS = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

function part(value, limit) {
  // A value for the evidence detail: whitespace collapsed, ";" made "," (it separates the parts), at most limit
  // characters (code points, as Python counts them), "-" when empty.
  const v = value.replace(WS, " ").replace(/^ +| +$/g, "").replace(/;/g, ",");
  return Array.from(v).slice(0, limit).join("") || "-";
}

async function lookup(entry, refs) {
  // [outcome, sim, record] for one register item, record being the closest [title, doi, venue] found.
  const title = entry.title || "";
  const locator = entry.locator || {};
  const withDoi = refs.find((r) => r.doi);
  const doi = locator.doi || (withDoi ? withDoi.doi : null);
  const withUrl = refs.find((r) => r.url);
  const url = locator.url || (withUrl ? withUrl.url : null);
  if (doi) {
    const [status, body] = await fetchUrl(GATE_ID, "https://api.crossref.org/works/" + pct(cleanDoi(doi), "/"));
    if (status === 200) {
      let found = crossrefRecord(JSON.parse(body).message || {});
      if (!found[1]) found = [found[0], cleanDoi(doi), found[2]];
      const sim = similarity(title, found[0]);
      return [sim >= 90 ? "verified" : "doi_title_mismatch", sim, found];
    }
    if (status === 404) return ["doi_not_found", 0, NONE];
    return ["lookup_error", 0, NONE];
  }
  const arxivId = locator.arxiv_id;
  if (arxivId) {
    const [status, body] = await fetchUrl(GATE_ID, "https://export.arxiv.org/api/query?id_list=" + pct(arxivId));
    if (status !== 200) return ["lookup_error", 0, NONE];
    const [sim, found] = bestOf(title, arxivRecords(body));
    return [sim >= 90 ? "verified" : "not_found", sim, found];
  }
  let [status, body] = await fetchUrl(GATE_ID, "https://api.crossref.org/works?query.bibliographic=" + pct(title) + "&rows=5");
  if (status !== 200) return ["lookup_error", 0, NONE];
  const items = (JSON.parse(body).message || {}).items || [];
  let [sim, found] = bestOf(title, items.filter((i) => i.title && i.title.length).map(crossrefRecord));
  if (sim < 90) {
    [status, body] = await fetchUrl(GATE_ID, "https://export.arxiv.org/api/query?search_query="
      + pct('ti:"' + title + '"') + "&max_results=3");
    if (status !== 200) return ["lookup_error", 0, NONE];
    const [sim2, found2] = bestOf(title, arxivRecords(body));
    if (sim2 > sim) [sim, found] = [sim2, found2];
  }
  if (sim >= 90) return ["verified", sim, found];
  if (sim >= 75) return ["possible", sim, found];
  if (url) return ["unverified_url", sim, found];
  return ["not_found", sim, found];
}

async function check(gateInput, load) {
  const draft = load(gateInput.target);
  const register = load(gateInput.extra_inputs[0]);
  const items = register.items || [];
  const registerIds = new Set(items.map((e) => e.source_id));
  const references = draft.references || [];
  const refSources = new Set(references.map((r) => r.source_id));
  const counts = {};
  for (const k of ORDER) counts[k] = 0;
  const evidence = [];
  const flag = (outcome, ref) => {
    counts[outcome] += 1;
    evidence.push({ ref, detail: outcome });
  };
  const claims = [];
  (draft.sections || []).forEach((section, si) => {
    (section.paragraphs || []).forEach((para, pi) => {
      const [ids, unparsed] = markers(para.text || "");
      for (const sid of ids) {
        if (!refSources.has(sid)) flag("unresolved_citation", (si + 1) + "." + (pi + 1) + ":" + sid);
      }
      for (let k = 0; k < unparsed; k++) flag("unparsed_marker", (si + 1) + "." + (pi + 1));
      for (const claim of para.claims || []) claims.push(claim);
    });
  });
  for (const claim of claims) {
    for (const sup of claim.support || []) {
      if (!refSources.has(sup.source_id)) flag("unresolved_citation", claim.claim_id + ":" + sup.source_id);
    }
  }
  for (const claim of claims) {
    if (claim.kind === "evidence" && !(claim.support || []).length) flag("unsupported_claim", claim.claim_id);
  }
  if (claims.length && !references.length) flag("no_references", "draft");
  for (const ref of references) {
    if (!registerIds.has(ref.source_id)) flag("reference_not_in_register", ref.ref_id);
  }
  let seen = new Set();
  for (const ref of references) {
    if (seen.has(ref.ref_id)) flag("duplicate_ref_id", ref.ref_id);
    seen.add(ref.ref_id);
  }
  seen = new Set();
  for (const entry of items) {
    if (seen.has(entry.source_id)) flag("duplicate_register_id", entry.source_id);
    seen.add(entry.source_id);
  }
  for (const entry of items) {
    const refs = references.filter((r) => r.source_id === entry.source_id);
    const [outcome, sim, found] = await lookup(entry, refs);
    counts[outcome] += 1;
    if (outcome !== "verified") {
      // The closest record's title as published (not folded), its DOI and its venue, so the person can judge a near
      // match (ask 109). At most 200 + 80 + 58 characters, so the detail stays within 400.
      evidence.push({ ref: entry.source_id, detail: outcome + "; sim=" + sim + "; found=" + part(found[0], 200)
        + "; found_doi=" + part(found[1], 80) + "; found_venue=" + part(found[2], 58) });
    }
  }
  let failed = 0;
  for (const k of FAIL) failed += counts[k];
  const warn = [...WARN].some((k) => counts[k]);
  const status = failed ? "fail" : warn ? "warn" : "pass";
  const summary = { ref: "summary", detail: ORDER.map((k) => k + "=" + counts[k]).join(" ") };
  return [status, items.length, failed, [summary].concat(evidence)];
}

run(GATE_ID, GATE_REF, check);
