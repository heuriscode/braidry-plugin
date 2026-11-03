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


// Numbers and their keys. See gate.py.
const NUMBER = /(?<![A-Za-z0-9_])(?<![A-Za-z]-)(?:[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|\.[0-9]+)(?![0-9])(?!(?:st|nd|rd|th)(?![A-Za-z]))/g;
const YEAR = /^[0-9]{4}$/;
const MIN_FRAGMENT = 6;
const FRAGMENT_SPLIT = /\[\.\.\.\]|\.\.\.|…/;

function numKey(literal) {
  let s = literal.replace(/,/g, "");
  if (s.startsWith(".")) s = "0" + s;
  const dot = s.indexOf(".");
  let whole = dot < 0 ? s : s.slice(0, dot);
  let frac = dot < 0 ? "" : s.slice(dot + 1);
  whole = whole.replace(/^0+/, "") || "0";
  frac = frac.replace(/0+$/, "");
  return whole + (frac ? "." + frac : "");
}

function numbers(text) {
  return Array.from(text.matchAll(NUMBER), (m) => [m[0], numKey(m[0])]);
}

function fold(text) {
  return asciiFold(text.replace(/-[ \t]*\r?\n[ \t]*/g, ""));
}

function named(gateInput, name) {
  for (const port of gateInput.extra_inputs || []) if (port.port === name) return port;
  throw new Error("missing input port " + name);
}

function optional(gateInput, name) {
  for (const port of gateInput.extra_inputs || []) if (port.port === name) return port;
  return null;
}


// Number context (number_context.py, user test phase 2C). See gate.py.
const NUM_DATES = new RegExp("(?<![0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}(?![0-9])|(?<![0-9.,/-])[0-9]{1,2}([/-])[0-9]{1,2}\\1(?:[0-9]{4}|[0-9]{2})(?![0-9])|(?<![0-9])(?:19|20)[0-9]{2}[-\u2013/](?:(?:19|20)[0-9]{2}|[0-9]{2})(?![0-9])|(?<![A-Za-z0-9_.,])[0-3]?[0-9](?:st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)(?![A-Za-z])|(?<![A-Za-z])(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[.]?[ \\t]+[0-3]?[0-9](?:st|nd|rd|th)?(?![0-9])(?![ \\t]*(?:%|per[ \\t]cent|percent))", "g");
const NUM_LABELS = new RegExp("(?<![A-Za-z])(?:[Rr]ecommendations?|[Ff]igures?|[Ff]igs?\\.|[Tt]ables?|[Ss]ections?|[Cc]hapters?|[Aa]ppendix|[Aa]ppendices|[Ii]tems?|[Ss]teps?|[Oo]ptions?|[Pp]arts?|[Bb]oxes|[Bb]ox|[Pp]aragraphs?|[Pp]aras?\\.|[Cc]lauses?|[Ss]chedules?|[Aa]nnex(?:es)?|[Aa]ttachments?|[Qq]uestions?|[Ff]indings?|[Aa]ctions?|[Pp]rinciples?|[Oo]bjectives?|[Pp]hases?|[Ss]tages?|[Vv]olumes?|[Vv]ols?\\.|[Nn]os?\\.|[Pp]ages?|[Pp]p?\\.|[Ss]cenarios?|[Bb]ands?|[Tt]iers?|[Ll]evels?|[Rr]ounds?|[Ww]aves?|[Aa]rms?|[Cc]ohorts?|[Gg]roups?)[ \\t]+[0-9]+(?:\\.[0-9]+)*[A-Za-z]?(?:[ \\t]*,[ \\t]*[0-9]+(?:\\.[0-9]+)*[A-Za-z]?(?=[ \\t]*(?:,|and[ \\t]|or[ \\t]|&)))*(?:[ \\t]*,?[ \\t]*(?:and|or|to|&|-|\u2013)[ \\t]*[0-9]+(?:\\.[0-9]+)*[A-Za-z]?)?", "g");
const NUM_LIST = new RegExp("(^|\\n[ \\t]*|[.;:!?][ \\t]+)\\(?[0-9]{1,3}[.)](?=[ \\t])", "g");

function unlabel(text) {
  return text.replace(NUM_DATES, " ").replace(NUM_LABELS, " ").replace(NUM_LIST, (whole, pre) => pre + " ");
}

function personTexts(focus, direction) {
  const out = [];
  const walk = (value) => {
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (typeof value === "string") out.push(value);
    else if (typeof value === "number") out.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object") {
      for (const k of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) walk(value[k]);
    }
  };
  walk(focus);
  if (direction && typeof direction === "object" && !Array.isArray(direction)) walk(direction.text);
  return out;
}


const GATE_ID = "cmd_inventory_gate";
const GATE_REF = "cmd_inventory_gate@0.3.0";
const ORDER = ["duplicate_item", "unknown_source", "unknown_paragraph", "not_in_paragraph", "no_number",
  "banned_term", "number_missed", "quote_missed", "unused_reference", "nothing_to_check"];
const STRICT_WARNS = ["number_missed", "quote_missed"];
const SQUARE = /\[([^\[\]]*)\]/g;
const NUMERIC_CITE = /^[0-9,\-– \t]+$/;
const PAREN = /\(([^()]*)\)/g;
const AUTHOR_YEAR = /^[ \t]*(?:[A-Z][^0-9;]*?,?[ \t]+)?(?:19|20)[0-9]{2}[a-z]?(?:,[ \t]*pp?\.?[ \t]*[0-9]+(?:[ \t]*[-–][ \t]*[0-9]+)?)?[ \t]*$/;
const QUOTED = /[“"]([^”"]{12,})[”"]/g;
const LINK = /(?:https?:\/\/|[Dd][Oo][Ii]:[ \t]*|10\.[0-9]{4,9}\/)[^ \t\r\n<>()\[\]]+/g;
const REFERENCE_HEADINGS = ["references", "reference list", "bibliography", "works cited", "literature cited",
  "sources", "notes", "endnotes", "footnotes"];

// See gate.py.
function uncite(text) {
  const t = text.replace(LINK, " ").replace(SQUARE, (whole, inner) =>
    NUMERIC_CITE.test(inner) || stripAscii(inner).startsWith("@") ? " " : whole,
  );
  return t.replace(PAREN, (whole, inner) => (inner.split(";").every((p) => AUTHOR_YEAR.test(p)) ? " " : whole));
}

function isYear(literal) {
  return YEAR.test(literal) && Number(literal) >= 1900 && Number(literal) <= 2100;
}

function paddedIn(needle, haystack) {
  return needle !== "" && (" " + haystack + " ").includes(" " + needle + " ");
}

function check(gateInput, load) {
  const inventory = load(gateInput.target);
  const doc = load(named(gateInput, "document"));
  const register = load(named(gateInput, "sources"));
  const config = gateInput.config || {};
  const strict = config.every_number_traces === true;
  const terms = (config.banned_terms || []).filter((t) => typeof t === "string");
  const glossary = optional(gateInput, "glossary");
  if (glossary !== null) {
    for (const t of load(glossary).terms || []) if (typeof t.term === "string") terms.push(t.term);
  }
  const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
  const failures = [];
  const warnings = [];
  const flag = (outcome, ref) => {
    counts[outcome] += 1;
    const warn = outcome === "unused_reference" || outcome === "nothing_to_check" || (STRICT_WARNS.includes(outcome) && !strict);
    (warn ? warnings : failures).push({ ref, detail: outcome });
  };
  const paras = new Map();
  const order = [];
  for (const section of doc.sections || []) {
    const listed = REFERENCE_HEADINGS.includes(fold(section.heading || ""));
    for (const para of section.paragraphs || []) {
      const pid = idStr(para.paragraph_id);
      if (!paras.has(pid)) {
        paras.set(pid, para.text || "");
        if (!listed) order.push(pid);
      }
    }
  }
  const registerIds = [];
  for (const entry of register.items || []) {
    const sid = idStr(entry.source_id);
    if (!registerIds.includes(sid)) registerIds.push(sid);
  }
  const seen = new Set();
  const cited = new Set();
  const keys = new Map(Array.from(paras.keys(), (pid) => [pid, new Set()]));
  const quotes = new Map(Array.from(paras.keys(), (pid) => [pid, []]));
  let checked = 0;
  for (const item of inventory.items || []) {
    checked += 1;
    const iid = idStr(item.item_id);
    if (seen.has(iid)) {
      flag("duplicate_item", iid);
      continue;
    }
    seen.add(iid);
    for (const raw of item.source_ids || []) {
      const sid = idStr(raw);
      cited.add(sid);
      if (!registerIds.includes(sid)) flag("unknown_source", iid + "#" + sid);
    }
    const pid = idStr(item.paragraph_id);
    if (!paras.has(pid)) {
      flag("unknown_paragraph", iid);
      continue;
    }
    const text = item.text || "";
    if (!paddedIn(fold(text), fold(paras.get(pid)))) {
      flag("not_in_paragraph", iid);
      continue;
    }
    if (item.kind === "number") {
      const found = numbers(item.value || "");
      if (!found.length) {
        flag("no_number", iid);
        continue;
      }
      if (!numbers(paras.get(pid)).some(([, k]) => k === found[0][1])) {
        flag("not_in_paragraph", iid);
        continue;
      }
      keys.get(pid).add(found[0][1]);
    } else if (item.kind === "quote") {
      quotes.get(pid).push(fold(text));
    }
  }
  for (const pid of order) {
    const text = paras.get(pid);
    checked += 1;
    for (const [literal, key] of numbers(unlabel(uncite(text)))) {
      if (!isYear(literal) && !keys.get(pid).has(key)) flag("number_missed", pid + "#" + literal);
    }
    for (const m of text.matchAll(QUOTED)) {
      const span = fold(m[1]);
      if (span.length < MIN_FRAGMENT) continue;
      if (!quotes.get(pid).some((q) => q && (span.includes(q) || q.includes(span)))) {
        flag("quote_missed", pid + "#" + Array.from(stripAscii(m[1])).slice(0, 60).join(""));
      }
    }
    const folded = fold(text);
    for (const term of terms) if (paddedIn(fold(term), folded)) flag("banned_term", pid + "#" + term);
  }
  for (const sid of registerIds) if (!cited.has(sid)) flag("unused_reference", sid);
  // An empty inventory, or a draft with nothing to scan, is never a pass (user test phase 2B).
  if (!(inventory.items || []).length || !order.length) flag("nothing_to_check", "inventory");
  const failed = failures.length;
  const status = failed ? "fail" : warnings.length ? "warn" : "pass";
  const summary = ORDER.map((k) => k + "=" + counts[k]).join(" ");
  return [status, checked, failed, [{ ref: "summary", detail: summary }, ...failures, ...warnings]];
}

run(GATE_ID, GATE_REF, check);
