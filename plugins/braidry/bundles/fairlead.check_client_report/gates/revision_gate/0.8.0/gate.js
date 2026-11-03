// --- gatekit 0.3.0 (JavaScript) --- embedded verbatim in every JS gate; tests/braids/test_gatekit.py checks it.
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


const GATE_ID = "revision_gate";
const GATE_REF = "revision_gate@0.8.0";
const ORDER = ["duplicate_id", "unassigned_id", "unknown_id", "unlogged_change", "change_unauthorised",
  "rejected_finding_applied", "decision_not_applied", "minor_decision_not_applied", "unattributed_change", "claimed_unchanged", "claimed_unchanged_path",
  "change_set_truncated"];
const WARNS = ["minor_decision_not_applied", "unattributed_change", "claimed_unchanged", "claimed_unchanged_path",
  "change_set_truncated"];
const ADOPTED = ["adopted", "partly_adopted"];
const APPLIED = ["applied", "partly_applied"];

// 0.8.0 (ChoiceLab design review 6, m7): the findings the person rejected on the per-finding card, when
// finding_choices is served; an empty set otherwise, so the gate is 0.7.0.
function rejectedByPerson(gateInput, load) {
  const port = optional(gateInput, "finding_choices");
  if (port === null) return new Set();
  return new Set((load(port).choices || []).filter((c) => c.choice === "reject").map((c) => c.finding_id));
}

function named(gateInput, name) {
  for (const port of gateInput.extra_inputs || []) {
    if (port.port === name) return port;
  }
  throw new Error("missing input port " + name);
}

// A named extra input, or null when the step was not served it (0.6.0's composition ports are optional).
function optional(gateInput, name) {
  for (const port of gateInput.extra_inputs || []) if (port.port === name) return port;
  return null;
}

// The path is the prefix or lies below it, by whole segments ("/a/2" covers "/a/2/b", not "/a/20").
const under = (path, prefix) => path === prefix || path.startsWith(prefix + "/");

function scan(doc) {
  const parents = new Map();
  const dups = [];
  let nulls = 0;
  for (const [kind, node, parent] of kitItems(doc)) {
    const itemId = kitGet(node, KIT_ID_KEY[kind]);
    if (itemId === null) {
      nulls += 1;
      continue;
    }
    if (parents.has(itemId) && !dups.includes(itemId)) dups.push(itemId);
    parents.set(itemId, parent);
  }
  return [parents, dups, nulls];
}

function lineage(itemId, parents) {
  const out = [];
  while (itemId !== null && itemId !== undefined && !out.includes(itemId)) {
    out.push(itemId);
    itemId = parents.has(itemId) ? parents.get(itemId) : null;
  }
  return out;
}

async function check(gateInput, load) {
  const log = load(gateInput.target);
  const before = load(named(gateInput, "document_before"));
  const after = load(named(gateInput, "document"));
  const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
  const failures = [];
  const warnings = [];
  const flag = (outcome, ref) => {
    counts[outcome] += 1;
    (WARNS.includes(outcome) ? warnings : failures).push({ ref, detail: outcome });
  };
  const [pBefore, dBefore, nBefore] = scan(before);
  const [pAfter, dAfter, nAfter] = scan(after);
  for (const [port, dups] of [["document_before", dBefore], ["document", dAfter]]) {
    for (const itemId of dups) flag("duplicate_id", port + "#" + itemId);
  }
  for (const [port, nulls] of [["document_before", nBefore], ["document", nAfter]]) {
    if (nulls) flag("unassigned_id", port);
  }
  const logged = [];
  for (const entry of log.entries || []) {
    for (const itemId of entry.changed_ids || []) if (!logged.includes(itemId)) logged.push(itemId);
  }
  for (const itemId of logged) {
    if (!pBefore.has(itemId) && !pAfter.has(itemId)) flag("unknown_id", itemId);
  }
  let checked = 0;
  let reordered = false;
  if (!failures.length) {
    const parents = new Map([...pBefore, ...pAfter]);
    const result = changeSet(before, after);
    reordered = result.reordered;
    checked = result.items.length;
    const loggedSet = new Set(logged);
    const coveredBy = new Set();
    for (const item of result.items) {
      const chain = lineage(item.id, parents);
      for (const i of chain) coveredBy.add(i);
      if (!chain.some((i) => loggedSet.has(i))) flag("unattributed_change", item.id);
    }
    for (const itemId of logged) if (!coveredBy.has(itemId)) flag("claimed_unchanged", itemId);
  }
  // 0.6.0 (ChoiceLab design review 4, M7): every change to the composition is logged against an adopted decision
  // or one the person directed.
  const changesPort = optional(gateInput, "composition_changes");
  if (changesPort !== null) {
    const changes = load(changesPort);
    const decisionsPort = optional(gateInput, "decisions");
    const adopted = decisionsPort === null ? null
      : new Set((load(decisionsPort).decisions || []).filter((d) => ADOPTED.includes(d.action)).map((d) => d.finding_id));
    if (adopted !== null) for (const fid of rejectedByPerson(gateInput, load)) adopted.delete(fid);
    const direction = new Set((gateInput.config || {}).direction_steps || []);
    const entries = (log.entries || []).filter((e) => e.changed_paths && e.changed_paths.length);
    if (changes.truncated) flag("change_set_truncated", "composition_changes");
    const paths = [];
    for (const op of changes.ops || []) if (!paths.includes(op.path)) paths.push(op.path);
    checked += paths.length;
    for (const path of paths) {
      const covering = entries.filter((e) => e.changed_paths.some((q) => under(path, q)));
      if (!covering.length) flag("unlogged_change", path);
      else if (adopted !== null && !covering.some((e) => direction.has((e.decision_ref || {}).step_id)
          || adopted.has((e.decision_ref || {}).finding_id))) flag("change_unauthorised", path);
    }
    const claimed = [];
    for (const e of entries) {
      for (const q of e.changed_paths) {
        if (!claimed.includes(q) && !paths.some((p) => under(p, q) || under(q, p))) {
          claimed.push(q);
          flag("claimed_unchanged_path", q);
        }
      }
    }
  }
  // 0.7.0 (ChoiceLab design review 5, M7): every adopted or partly adopted decision has a log entry that applied
  // it. An adopted one fails (decision_not_applied); a partly adopted one, or an adopted finding its checker
  // rated warn (when the findings are served, in ports named findings*), warns (minor_decision_not_applied).
  const decisionsPort = optional(gateInput, "decisions");
  if (decisionsPort !== null) {
    const severity = new Map();
    for (const port of gateInput.extra_inputs || []) {
      if ((port.port || "").startsWith("findings")) {
        for (const f of load(port).findings || []) severity.set(f.finding_id, f.severity);
      }
    }
    const applied = new Set((log.entries || []).filter((e) => APPLIED.includes(e.action))
      .map((e) => (e.decision_ref || {}).finding_id));
    const rejected = rejectedByPerson(gateInput, load);
    for (const d of load(decisionsPort).decisions || []) {
      const fid = d.finding_id;
      // 0.8.0: a finding the person rejected is never applied, and is not asked for.
      if (ADOPTED.includes(d.action) && rejected.has(fid)) {
        if (applied.has(fid)) {
          checked += 1;
          flag("rejected_finding_applied", fid);
        }
      } else if (ADOPTED.includes(d.action) && !applied.has(fid)) {
        checked += 1;
        const minor = d.action === "partly_adopted" || severity.get(fid) === "warn";
        flag(minor ? "minor_decision_not_applied" : "decision_not_applied", fid);
      }
    }
  }
  const failed = failures.length;
  const status = failed ? "fail" : warnings.length ? "warn" : "pass";
  let summary = ORDER.map((k) => k + "=" + counts[k]).join(" ");
  summary += " changes=" + checked + " reordered=" + (reordered ? 1 : 0);
  return [status, checked, failed, [{ ref: "summary", detail: summary }, ...failures, ...warnings]];
}

run(GATE_ID, GATE_REF, check);
