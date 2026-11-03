// --- gatekit 0.4.0 (JavaScript) --- embedded verbatim in every JS gate; tests/braids/test_gatekit.py checks it.
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

function idStr(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    throw new TypeError("gatekit.idStr: not an id: number");
  }
  if (typeof value === "string") return value;
  throw new TypeError("gatekit.idStr: not an id: " + (Array.isArray(value) ? "list" : typeof value));
}

function stripAscii(text) {
  return text.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
}

// Kit documents (gatekit 0.3.0): Fairlead-assigned ids and computed change sets (R1 D-1, D-2).
const KIT_PREFIX = { section: "sec", paragraph: "par", claim: "clm", figure: "fig" };
const KIT_ID_KEY = { section: "section_id", paragraph: "paragraph_id", claim: "claim_id", figure: "figure_id" };

function kitGet(node, key) {
  return node[key] === undefined ? null : node[key];
}

function kitItems(doc) {
  const out = [];
  (doc.sections || []).forEach((sec, si) => {
    out.push(["section", sec, null, "s" + si]);
    (sec.paragraphs || []).forEach((par, pi) => {
      const ppath = "s" + si + ".p" + pi;
      out.push(["paragraph", par, kitGet(sec, "section_id"), ppath]);
      (par.claims || []).forEach((cl, ci) => out.push(["claim", cl, kitGet(par, "paragraph_id"), ppath + ".c" + ci]));
      (par.figures || []).forEach((fg, fi) => out.push(["figure", fg, kitGet(par, "paragraph_id"), ppath + ".f" + fi]));
    });
  });
  return out;
}

function assignIds(prev, doc, salt) {
  const out = JSON.parse(JSON.stringify(doc));
  const known = new Set();
  if (prev !== null && prev !== undefined) {
    for (const [kind, node] of kitItems(prev)) known.add(kitGet(node, KIT_ID_KEY[kind]));
  }
  const problems = [];
  const seen = new Set();
  const items = kitItems(out);
  for (const [kind, node] of items) {
    const itemId = kitGet(node, KIT_ID_KEY[kind]);
    if (itemId === null) continue;
    if (seen.has(itemId)) problems.push("duplicate_id:" + itemId);
    else if (!known.has(itemId)) problems.push("minted_id:" + itemId);
    seen.add(itemId);
  }
  const taken = new Set([...known, ...seen]);
  for (const [kind, node, , path] of items) {
    const key = KIT_ID_KEY[kind];
    if (kitGet(node, key) !== null) continue;
    let n = 0;
    let candidate;
    for (;;) {
      const digest = crypto.createHash("sha256").update(salt + "|" + kind + "|" + path + "|" + String(n), "utf8").digest("hex");
      candidate = KIT_PREFIX[kind] + "_" + digest.slice(0, 8);
      if (!taken.has(candidate)) break;
      n += 1;
    }
    node[key] = candidate;
    taken.add(candidate);
  }
  return [out, problems];
}

function kitSame(a, b) {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, k) => kitSame(x, b[k]));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, n) => k === kb[n] && kitSame(a[k], b[k]));
}

function kitContent(kind, node) {
  if (kind === "section") return { heading: kitGet(node, "heading") };
  if (kind === "paragraph") return { text: kitGet(node, "text") };
  if (kind === "claim") return { text: kitGet(node, "text"), kind: kitGet(node, "kind"), support: kitGet(node, "support") };
  const out = {};
  for (const k of ["value", "unit", "source_id", "run_ref", "anchor"]) out[k] = kitGet(node, k);
  return out;
}

function kitShow(kind, node) {
  if (kind === "section") return kitGet(node, "heading");
  if (kind === "paragraph" || kind === "claim") return kitGet(node, "text");
  const value = kitGet(node, "value");
  const shown = typeof value === "string" ? value : value === null ? "" : String(value);
  return shown + (kitGet(node, "unit") ? " " + node.unit : "");
}

function kitIndex(doc) {
  const index = new Map();
  const order = [];
  for (const [kind, node, parent] of kitItems(doc)) {
    const itemId = kitGet(node, KIT_ID_KEY[kind]);
    if (itemId === null) throw new Error("gatekit.changeSet: unassigned id in a " + kind);
    index.set(itemId, [kind, node, parent]);
    order.push(itemId);
  }
  return [index, order];
}

function changeSet(before, after) {
  const [bIndex, bOrder] = kitIndex(before);
  const [aIndex, aOrder] = kitIndex(after);
  const items = [];
  for (const itemId of aOrder) {
    const [kind, node, parent] = aIndex.get(itemId);
    if (!bIndex.has(itemId)) {
      items.push({ id: itemId, kind, change: "added", fields: [], before: null, after: kitShow(kind, node) });
      continue;
    }
    const [, old, oldParent] = bIndex.get(itemId);
    const newC = kitContent(kind, node);
    const oldC = kitContent(kind, old);
    const fields = Object.keys(newC).filter((k) => !kitSame(newC[k], oldC[k]));
    if (parent !== oldParent) fields.push("parent");
    fields.sort();
    if (fields.length) {
      items.push({ id: itemId, kind, change: "changed", fields, before: kitShow(kind, old), after: kitShow(kind, node) });
    }
  }
  for (const itemId of bOrder) {
    if (!aIndex.has(itemId)) {
      const [kind, old] = bIndex.get(itemId);
      items.push({ id: itemId, kind, change: "removed", fields: [], before: kitShow(kind, old), after: null });
    }
  }
  const commonB = bOrder.filter((i) => aIndex.has(i));
  const commonA = aOrder.filter((i) => bIndex.has(i));
  return { items, reordered: commonB.length !== commonA.length || commonB.some((v, k) => v !== commonA[k]) };
}

// Citations (gatekit 0.4.0; R1 D-4): a bracket starting "[@" is parsed strictly; any other bracket is prose.
const CITE_ID = "[A-Za-z0-9_](?:[A-Za-z0-9_.:-]*[A-Za-z0-9_])?";
const CITE_PART = new RegExp("^@(" + CITE_ID + ")(?:, (?:p|pp|ch|sec|para)\\. [^;\\]]{1,40})?$");
const CITE_POSSIBLE = /(?:^|[ ;(])@[A-Za-z0-9_]/;

function parseCitations(text) {
  const markers = [];
  const malformed = [];
  const possible = [];
  let pos = 0;
  for (;;) {
    const i = text.indexOf("[", pos);
    if (i < 0) break;
    const j = text.indexOf("]", i + 1);
    if (text.startsWith("[@", i)) {
      if (j < 0) {
        malformed.push(Array.from(text.slice(i)).slice(0, 120).join(""));
        break;
      }
      const ids = [];
      let ok = true;
      for (const part of text.slice(i + 1, j).split(";")) {
        const m = CITE_PART.exec(stripAscii(part));
        if (!m) {
          ok = false;
          break;
        }
        ids.push(m[1]);
      }
      if (ok) markers.push({ text: text.slice(i, j + 1), ids });
      else malformed.push(text.slice(i, j + 1));
      pos = j + 1;
      continue;
    }
    if (j < 0) break;
    const inner = text.indexOf("[", i + 1);
    if (inner >= 0 && inner < j) {
      pos = inner;
      continue;
    }
    if (CITE_POSSIBLE.test(text.slice(i + 1, j))) possible.push(text.slice(i, j + 1));
    pos = j + 1;
  }
  return { markers, malformed, possible };
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


// --- lit_record_gate 0.1.0 ---
const GATE_ID = "lit_record_gate";
const GATE_REF = "lit_record_gate@0.1.0";
const ORDER = ["reading_level_stated", "count_hedged", "included_count_differs", "included_count_changed"];
const FAILS = ORDER.slice(0, 3);

const WORDS = (
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen " +
  "fifteen sixteen seventeen eighteen nineteen twenty"
).split(" ");
const WORD_ALT = [...WORDS].sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0)).join("|");
const NUM = "(?:([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(\\.[0-9]+)?(?![0-9a-z])|(" + WORD_ALT + ")(?![a-z0-9-]))";
const HEDGES = ["approximately", "an estimated", "fewer than", "more than", "less than", "roughly", "nearly",
  "around", "almost", "approx.", "approx", "circa", "about", "some", "over"];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HEDGED = new RegExp("(?<![a-z0-9])(" + HEDGES.map(esc).join("|") + ")[ \\t\\n]+" + NUM +
  "|(~)[ \\t]*" + NUM, "g");
const NOUNS = new Set((
  "record records study studies source sources paper papers article articles duplicate " +
  "duplicates near-duplicate near-duplicates hit hits result results item items work works " +
  "report reports publication publications chapter chapters citation citations entry " +
  "entries preprint preprints"
).split(" "));
const VERBS = new Set((
  "found identified retrieved returned screened excluded included removed examined assessed " +
  "deduplicated located kept dropped read"
).split(" "));
const BE = new Set(["were", "was", "are", "is", "been", "be", "had", "have", "has"]);
const STOPS = new Set((
  "in with from by for but nor to at on per across that which who than as between among " +
  "into over under since during after before each a an the years year times"
).split(" "));
const LEAD_WORDS = new Set([...NOUNS, ...VERBS, "count", "counts", "reason", "reasons"]);
const ADJ = new Set("unique distinct eligible remaining additional relevant new further".split(" "));
const SCREEN_WORDS = new Set("screen screened screening deduplication deduplicated".split(" "));
const SENTENCE_MARK = ".!?\n";
const SCALE = new RegExp("[ \\t]*(?:%|per[ \\t-]?cent(?![a-z])|percent(?![a-z])" +
  "|hundred|thousand|million|billion|trillion)", "y");
const TOKEN = /[ \t\n]*([a-z]+(?:-[a-z]+)*)/y;
const WORD_TOKEN = /[a-z]+(?:-[a-z]+)*/g;
const CLAUSE_END = /[ \t]*(?:\n|$|[.;,:)\]!?])/y;
const CLAUSE_MARK = ".;:!?()[],\n";
const LIST_ITEM = /[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+/y;
const LINE_TAIL = /[ \t]*[.;,]?[ \t]*(?:\n|$)/y;

const SP = "[ \\t\\n]+";
const KINDS = "(?:work|works|source|sources|study|studies|record|records|paper|papers|article|articles" +
  "|item|items|report|reports|included work|included works|included source|included sources|included study" +
  "|included studies)";
const FULL = "full(?:-| )texts?";
const READING = [
  "(?:no|none of the) " + KINDS + " (?:was|were) (?:read|opened|obtained|retrieved) in full",
  "(?:none|nothing) (?:of them )?(?:was|were) read in full",
  "not (?:been )?read in full",
  "(?:no|without) " + FULL + " (?:reading|read|review|was read|were read)",
  FULL + " (?:was|were) not (?:read|opened)",
  "read (?:only )?(?:at|on|from) (?:the )?(?:abstract|abstracts|bibliographic record|record|records)" +
    " (?:level|only)",
  "only (?:the )?abstracts? (?:was|were) read",
  "abstracts? only (?:was|were) read",
  "not read beyond (?:the )?(?:bibliographic )?record",
  "reading (?:was )?(?:limited|restricted) to (?:the )?(?:abstracts?|records?)",
];
const READING_RE = READING.map((p) =>
  new RegExp("(?<![a-z0-9])" + p.split(" ").join(SP) + "(?![a-z0-9])", "g"));
// On the draft, which states reading levels from the evidence table, only a statement about the whole set.
const WHOLE_RE = [0, 1, 3, 4, 6, 7, 9].map((i) => READING_RE[i]);
const INC_AFTER = new RegExp("(?<![a-z0-9-])included[ \\t]*(?::|=|\\(n[ \\t]*=)?[ \\t]*" + NUM, "g");
const INC_BEFORE = new RegExp("(?<![a-z0-9.,-])(?:([0-9]+)|(" + WORD_ALT +
  "))((?:[ \\t]+[a-z]+(?:-[a-z]+)*){0,3}?)" +
  "[ \\t]+included(?![a-z])", "g");
const INC_BETWEEN = new Set([...NOUNS, "were", "was", "are", "have", "been", "finally", "all", "unique",
  "eligible"]);

function portsByName(gateInput) {
  const out = new Map();
  for (const port of (gateInput.target ? [gateInput.target] : []).concat(gateInput.extra_inputs || [])) {
    out.set(port.port, port);
  }
  return out;
}

// A named input; a missing one is a protocol error (exit 4), never a silent skip.
function named(gateInput, name) {
  const port = portsByName(gateInput).get(name);
  if (port === undefined) throw new Error("missing input port " + name);
  return port;
}

function optional(gateInput, name) {
  const port = portsByName(gateInput).get(name);
  return port === undefined ? null : port;
}

function readText(port) {
  return fs.readFileSync(port.path).toString("utf8");
}

const ND = /^\p{Nd}$/u;

function isDigitCp(cp) {
  return cp >= 0 && ND.test(String.fromCodePoint(cp));
}

// NFKC; every decimal digit as its ASCII digit (its place in its aligned run of ten); ASCII lowercase;
// CR dropped.
function prepare(text) {
  const norm = text.normalize("NFKC").split("\r").join("");
  let out = "";
  for (const ch of norm) {
    const cp = ch.codePointAt(0);
    if ((cp >= 48 && cp <= 57) || !ND.test(ch)) {
      out += ch;
      continue;
    }
    let back = 0;
    while (isDigitCp(cp - back - 1)) back += 1;
    out += String.fromCharCode(48 + (back % 10));
  }
  return out.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function numberValue(digits, word) {
  if (word) return WORDS.indexOf(word);
  return parseInt(digits.split(",").join(""), 10);
}

function count(text, ch, end) {
  let n = 0;
  for (let i = 0; i < end; i++) if (text[i] === ch) n += 1;
  return n;
}

function lineOf(text, pos) {
  return count(text, "\n", pos) + 1;
}

function stickyAt(rx, text, pos) {
  rx.lastIndex = pos;
  return rx.exec(text);
}

function tokensAfter(text, pos, n) {
  const out = [];
  while (out.length < n) {
    const m = stickyAt(TOKEN, text, pos);
    if (!m) break;
    out.push(m[1]);
    pos = TOKEN.lastIndex;
  }
  return out;
}

function wordTokens(text) {
  return [...text.matchAll(WORD_TOKEN)].map((m) => m[0]);
}

function tokensBefore(text, pos, n) {
  let start = pos;
  while (start > 0 && !CLAUSE_MARK.includes(text[start - 1])) start -= 1;
  const all = wordTokens(text.slice(start, pos));
  return all.slice(Math.max(0, all.length - n));
}

// The nearest line above `index` that is neither blank nor a list item.
function leadIn(lines, index) {
  for (let k = index - 1; k >= 0; k--) {
    const line = lines[k];
    if (stripAscii(line) === "" || stickyAt(LIST_ITEM, line, 0)) continue;
    return line;
  }
  return "";
}

// What makes the hedged number at text[start:end] a count of records, or null.
// The sentence around text[start:end] names records or screening.
function namesRecords(text, start, end) {
  let s = start;
  while (s > 0 && !SENTENCE_MARK.includes(text[s - 1])) s -= 1;
  let e = end;
  while (e < text.length && !SENTENCE_MARK.includes(text[e])) e += 1;
  return wordTokens(text.slice(s, e)).some((t) => NOUNS.has(t) || SCREEN_WORDS.has(t));
}

// What makes the hedged number at text[start:end] a count of records in the draft, or null.
function countedBy(text, start, end) {
  const after = tokensAfter(text, end, 5);
  if (after.length && BE.has(after[0])) {
    const verb = after.slice(1, 5).find((t) => VERBS.has(t));
    if (verb !== undefined) return after[0] + "-" + verb;
  } else {
    const head = after.slice(0, 3);
    for (let i = 0; i < head.length; i++) {
      const t = head[i];
      if (NOUNS.has(t) || (i === 0 && VERBS.has(t))) return t;
      if (STOPS.has(t) || BE.has(t)) break;
    }
    if (after.length && ADJ.has(after[0]) && namesRecords(text, start, end)) return after[0];
  }
  if (stickyAt(CLAUSE_END, text, end)) {
    const before = tokensBefore(text, start, 4);
    for (let i = before.length - 1; i >= 0; i--) {
      if (NOUNS.has(before[i]) || VERBS.has(before[i])) return before[i];
    }
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (stickyAt(LIST_ITEM, text, lineStart) && stickyAt(LINE_TAIL, text, end)) {
    const lines = text.split("\n");
    const lead = wordTokens(leadIn(lines, count(text, "\n", start)));
    if (lead.some((t) => LEAD_WORDS.has(t))) return "list";
  }
  return null;
}

// [position, hedge, number, counted by] for every hedged number that counts records: in the search record,
// every hedged number.
function hedgedCounts(text, record) {
  const out = [];
  for (const m of text.matchAll(HEDGED)) {
    let hedge, digits, frac, word;
    if (m[1] !== undefined) [hedge, digits, frac, word] = [m[1], m[2], m[3], m[4]];
    else [hedge, digits, frac, word] = ["tilde", m[6], m[7], m[8]];
    const numEnd = m.index + m[0].length;
    if (record) {
      out.push([m.index, hedge, numberValue(digits, word), "record"]);
      continue;
    }
    if (frac !== undefined || stickyAt(SCALE, text, numEnd)) continue;
    const by = countedBy(text, m.index, numEnd);
    if (by !== null) out.push([m.index, hedge, numberValue(digits, word), by]);
  }
  return out;
}

function byPos(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

function readingStatements(text, patterns) {
  const found = [];
  for (const rx of patterns) {
    for (const m of text.matchAll(rx)) found.push([m.index, m.index + m[0].length]);
  }
  found.sort(byPos);
  const kept = [];
  for (const [start, end] of found) {
    if (kept.length && start < kept[kept.length - 1][1]) continue;
    kept.push([start, end]);
  }
  return kept;
}

function includedStatements(text) {
  const found = [];
  for (const m of text.matchAll(INC_AFTER)) {
    if (m[2] === undefined) found.push([m.index, numberValue(m[1], m[3])]);
  }
  for (const m of text.matchAll(INC_BEFORE)) {
    const between = wordTokens(m[3]);
    if (between.some((t) => !INC_BETWEEN.has(t))) continue;
    const nxt = tokensAfter(text, m.index + m[0].length, 1);
    if (nxt.length && NOUNS.has(nxt[0])) continue;
    found.push([m.index, numberValue(m[1], m[2])]);
  }
  found.sort(byPos);
  return found;
}

function hedgeItems(text, refOf, record) {
  return hedgedCounts(text, record).map(([pos, hedge, n, by]) => {
    const detail = "count_hedged; hedge=" + asciiFold(hedge) + "; n=" + n + "; by=" + by;
    return [pos, { ref: refOf(pos), detail }];
  });
}

// On the search record (s2r): every outcome fails. On the draft (s4r, s8r): the draft's reading-level and
// hedged-count statements fail; the search record is only compared with the register, which the writer may
// have changed since, as a warning (included_count_changed), unless the step that wrote the draft also wrote
// the search record (the reviser at s7): then its reading-level and hedged-number statements fail as at s2r.
function check(gateInput, load) {
  const record = prepare(readText(named(gateInput, "search_record")));
  const items = load(named(gateInput, "sources")).items || [];
  const draftPort = optional(gateInput, "draft");
  const counts = {};
  for (const k of ORDER) counts[k] = 0;
  let problems = [];
  const warns = [];
  const atLine = (pos) => "search_record:L" + lineOf(record, pos);
  const scan = (text, refOf, recordMode) => {
    const found = [];
    for (const [start, end] of readingStatements(text, recordMode ? READING_RE : WHOLE_RE)) {
      counts.reading_level_stated += 1;
      const words = asciiFold(text.slice(start, end)).slice(0, 120);
      found.push([start, 0, { ref: refOf(start), detail: "reading_level_stated; text=" + words }]);
    }
    for (const [pos, item] of hedgeItems(text, refOf, recordMode)) {
      counts.count_hedged += 1;
      found.push([pos, 1, item]);
    }
    return found;
  };
  let checked;
  if (draftPort === null) {
    const found = scan(record, atLine, true);
    for (const [pos, n] of includedStatements(record)) {
      if (n !== items.length) {
        counts.included_count_differs += 1;
        const detail = "included_count_differs; stated=" + n + "; register=" + items.length;
        found.push([pos, 2, { ref: atLine(pos), detail }]);
      }
    }
    found.sort(byPos);
    problems = found.map((f) => f[2]);
    checked = record.split("\n").filter((line) => stripAscii(line) !== "").length;
  } else {
    checked = 0;
    const draft = load(draftPort);
    (draft.sections || []).forEach((sec, si) => {
      const units = [["draft:s" + (si + 1), sec.heading || ""]];
      (sec.paragraphs || []).forEach((par, pi) =>
        units.push(["draft:" + (si + 1) + "." + (pi + 1), par.text || ""]));
      for (const [ref, raw] of units) {
        checked += 1;
        const found = scan(prepare(raw), () => ref, false);
        found.sort(byPos);
        problems = problems.concat(found.map((f) => f[2]));
      }
    });
    const made = (named(gateInput, "search_record").produced_by || {}).step_id;
    if (made !== undefined && made !== null && made === (draftPort.produced_by || {}).step_id) {
      const found = scan(record, atLine, true);
      found.sort(byPos);
      problems = problems.concat(found.map((f) => f[2]));
    }
    for (const [pos, n] of includedStatements(record)) {
      checked += 1;
      if (n !== items.length) {
        counts.included_count_changed += 1;
        warns.push({ ref: atLine(pos), detail: "included_count_changed; search_record=" + n + "; register=" +
          items.length });
      }
    }
  }
  const failed = FAILS.reduce((a, k) => a + counts[k], 0);
  const status = failed ? "fail" : counts.included_count_changed ? "warn" : "pass";
  const summary = { ref: "summary", detail: ORDER.map((k) => k + "=" + counts[k]).join(" ") };
  return [status, checked, failed, [summary, ...problems, ...warns]];
}

run(GATE_ID, GATE_REF, check);
