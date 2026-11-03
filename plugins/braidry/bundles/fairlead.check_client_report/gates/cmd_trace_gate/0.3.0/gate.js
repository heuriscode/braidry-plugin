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


const GATE_ID = "cmd_trace_gate";
const GATE_REF = "cmd_trace_gate@0.3.0";
const ORDER = ["quote_not_in_text", "number_not_in_text", "number_untraced", "quote_not_in_part",
  "number_not_in_part", "quote_unchecked", "number_unchecked", "quote_unsourced", "nothing_to_check"];
const FAILS = ["quote_not_in_text", "number_not_in_text", "number_untraced"];

function checkable(quote) {
  return quote.split(FRAGMENT_SPLIT).some((f) => fold(f).length >= MIN_FRAGMENT);
}

function quoteIn(quote, text) {
  const haystack = fold(text);
  for (const fragment of quote.split(FRAGMENT_SPLIT)) {
    const needle = fold(fragment);
    if (needle.length >= MIN_FRAGMENT && !haystack.includes(needle)) return false;
  }
  return true;
}

function check(gateInput, load) {
  const inventory = load(gateInput.target);
  const texts = load(named(gateInput, "source_texts"));
  const strict = (gateInput.config || {}).every_number_traces === true;
  const saved = new Map();
  for (const entry of texts.items || []) {
    const sid = idStr(entry.source_id);
    if (!saved.has(sid) && typeof entry.text === "string") saved.set(sid, entry);
  }
  const keys = new Map();
  const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
  const failures = [];
  const warnings = [];
  const flag = (outcome, ref) => {
    counts[outcome] += 1;
    const fail = FAILS.includes(outcome) || (strict && outcome === "quote_unsourced");
    (fail ? failures : warnings).push({ ref, detail: outcome });
  };
  let checked = 0;
  let uncited = 0;
  let labels = 0;
  for (const item of inventory.items || []) {
    const kind = item.kind;
    if (kind !== "quote" && kind !== "number") continue;
    if (kind === "number") {
      // A number that only labels something (Recommendation 2, a list's 1.) is not a number to trace.
      const value = numbers(item.value || "");
      const text = item.text || "";
      if (value.length && numbers(text).some(([, k]) => k === value[0][1]) &&
          !numbers(unlabel(text)).some(([, k]) => k === value[0][1])) {
        labels += 1;
        continue;
      }
    }
    const ref = idStr(item.item_id) + "@" + idStr(item.paragraph_id);
    const sources = (item.source_ids || []).map(idStr);
    if (!sources.length) {
      if (kind === "quote") flag("quote_unsourced", ref);
      else if (strict) flag("number_untraced", ref);
      else uncited += 1;
      continue;
    }
    checked += 1;
    const have = sources.filter((s) => saved.has(s)).map((s) => saved.get(s));
    if (kind === "quote") {
      const text = item.text || "";
      if (!checkable(text)) {
        flag("quote_unchecked", ref);
        continue;
      }
      if (have.some((h) => quoteIn(text, h.text))) continue;
    } else {
      const found = numbers(item.value || "");
      if (found.length) {
        for (const h of have) {
          const sid = idStr(h.source_id);
          if (!keys.has(sid)) keys.set(sid, new Set(numbers(h.text).map(([, k]) => k)));
        }
        if (have.some((h) => keys.get(idStr(h.source_id)).has(found[0][1]))) continue;
      }
    }
    const levels = have.map((h) => h.read_level);
    if (levels.includes("full_text")) flag(kind + "_not_in_text", ref);
    else if (levels.includes("full_text_partial")) flag(kind + "_not_in_part", ref);
    else flag(kind + "_unchecked", ref);
  }
  // No quote or number with a source to trace is never a pass (user test phase 2B).
  if (checked === 0) flag("nothing_to_check", "inventory");
  const failed = failures.length;
  const status = failed ? "fail" : warnings.length ? "warn" : "pass";
  const unchecked = counts.quote_unchecked + counts.number_unchecked;
  const summary = ORDER.map((k) => k + "=" + counts[k]).join(" ") + " uncited=" + uncited + " labels=" + labels +
    " unchecked=" + unchecked + " of " + checked;
  return [status, checked, failed, [{ ref: "summary", detail: summary }, ...failures, ...warnings]];
}

run(GATE_ID, GATE_REF, check);
