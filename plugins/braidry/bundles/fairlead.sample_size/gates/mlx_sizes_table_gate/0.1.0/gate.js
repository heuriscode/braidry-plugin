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


const GATE_ID = "mlx_sizes_table_gate";
const GATE_REF = "mlx_sizes_table_gate@0.1.0";


// A value as text, the same in both runtimes.
function show(value) {
  if (value === null || value === undefined) return "null";
  if (value === true || value === false) return value ? "true" : "false";
  return String(value);
}


// Wichura, M. J. (1988). Algorithm AS 241. See gate.py.
const A = [2.5090809287301226727e+3, 3.3430575583588128105e+4, 6.7265770927008700853e+4, 4.5921953931549871457e+4, 1.3731693765509461125e+4, 1.9715909503065514427e+3, 1.3314166789178437745e+2, 3.3871328727963666080e+0];
const B = [5.2264952788528545610e+3, 2.8729085735721942674e+4, 3.9307895800092710610e+4, 2.1213794301586595867e+4, 5.3941960214247511077e+3, 6.8718700749205790830e+2, 4.2313330701600911252e+1, 1.0];
const C = [7.74545014278341407640e-4, 2.27238449892691845833e-2, 2.41780725177450611770e-1, 1.27045825245236838258e+0, 3.64784832476320460504e+0, 5.76949722146069140550e+0, 4.63033784615654529590e+0, 1.42343711074968357734e+0];
const D = [1.05075007164441684324e-9, 5.47593808499534494600e-4, 1.51986665636164571966e-2, 1.48103976427480074590e-1, 6.89767334985100004550e-1, 1.67638483018380384940e+0, 2.05319162663775882187e+0, 1.0];
const E = [2.01033439929228813265e-7, 2.71155556874348757815e-5, 1.24266094738807843860e-3, 2.65321895265761230930e-2, 2.96560571828504891230e-1, 1.78482653991729133580e+0, 5.46378491116411436990e+0, 6.65790464350110377720e+0];
const F = [2.04426310338993978564e-15, 1.42151175831644588870e-7, 1.84631831751005468180e-5, 7.86869131145613259100e-4, 1.48753612908506148525e-2, 1.36929880922735805310e-1, 5.99832206555887937690e-1, 1.0];

function horner(cs, r) {
  let acc = cs[0];
  for (const c of cs.slice(1)) acc = acc * r + c;
  return acc;
}

function z(p) {
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (horner(A, r) * q) / horner(B, r);
  }
  let r = q <= 0.0 ? p : 1.0 - p;
  r = Math.sqrt(-Math.log(r));
  let x;
  if (r <= 5.0) {
    r = r - 1.6;
    x = horner(C, r) / horner(D, r);
  } else {
    r = r - 5.0;
    x = horner(E, r) / horner(F, r);
  }
  return q < 0.0 ? -x : x;
}

function up(x) {
  return Math.ceil(x - 1e-9);
}

function sizes(s) {
  const family = s.family;
  const za = z(1.0 - s.alpha / s.sides);
  const zb = z(s.power);
  const zz = (za + zb) * (za + zb);
  if (family === "two_means") {
    const [d, r] = [s.d, s.allocation_ratio];
    if (d === 0) return null;
    const n1 = ((1.0 + 1.0 / r) * zz) / (d * d);
    const [a, b] = [up(n1), up(r * n1)];
    return [a, b, a + b];
  }
  if (family === "two_proportions") {
    const [p1, p2, r] = [s.p1, s.p2, s.allocation_ratio];
    if (p1 === p2) return null;
    const pbar = (p1 + r * p2) / (1.0 + r);
    const x = za * Math.sqrt(pbar * (1.0 - pbar) * (1.0 + 1.0 / r));
    const y = zb * Math.sqrt(p1 * (1.0 - p1) + (p2 * (1.0 - p2)) / r);
    const n1 = ((x + y) * (x + y)) / ((p1 - p2) * (p1 - p2));
    const [a, b] = [up(n1), up(r * n1)];
    return [a, b, a + b];
  }
  if (family === "logistic_continuous") {
    if (s.odds_ratio === 1) return null;
    const beta = Math.log(s.odds_ratio);
    const rate = s.event_rate;
    const n = zz / (rate * (1.0 - rate) * beta * beta) / (1.0 - s.r2_other);
    return [null, null, up(n)];
  }
  return null;
}

function computed(scenarios) {
  const out = [];
  const parts = [];
  for (const s of scenarios) {
    const n = sizes(s);
    out.push([s, n]);
    if (n === null) continue;
    if (n[0] === null) parts.push(s.scenario_id + ": total=" + n[2]);
    else parts.push(s.scenario_id + ": n1=" + n[0] + " n2=" + n[1] + " total=" + n[2]);
  }
  return [out, parts.join("; ")];
}


const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7];

// ln Gamma(a) for a > 0.5 (Lanczos, g = 7). See gate.py.
function logGamma(a0) {
  const a = a0 - 1.0;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i += 1) x += LANCZOS[i] / (a + i);
  const t = a + 7.5;
  return 0.9189385332046727 + (a + 0.5) * Math.log(t) - t + Math.log(x);
}

// The regularised lower incomplete gamma P(a, x). See gate.py.
function lowerGamma(a, x) {
  if (x <= 0.0) return 0.0;
  const front = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1.0) {
    let term = 1.0 / a;
    let total = term;
    for (let n = 1; n < 1000; n += 1) {
      term = (term * x) / (a + n);
      total += term;
      if (term < total * 1e-16) break;
    }
    return total * front;
  }
  let b = x + 1.0 - a;
  let c = 1e300;
  let d = 1.0 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2.0;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1.0 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1.0) < 1e-16) break;
  }
  return 1.0 - front * h;
}

// The chi-square quantile at lower-tail p with k degrees of freedom, by bisection. See gate.py.
function chi2Lower(p, k) {
  let lo = 0.0;
  let hi = k + 100.0 * Math.sqrt(2.0 * k) + 100.0;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2.0;
    if (lowerGamma(k / 2.0, mid / 2.0) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2.0;
}

function sdUsed(basis) {
  if (basis.upper_limit === null || basis.upper_limit === undefined) return basis.sd;
  const n = basis.pilot_n;
  return basis.sd * Math.sqrt((n - 1) / chi2Lower(1.0 - basis.upper_limit, n - 1));
}

function effective(s) {
  const basis = s.sd_basis;
  if (s.family !== "two_means" || basis === null || typeof basis !== "object") return s;
  if (basis.upper_limit !== null && basis.upper_limit !== undefined && (basis.pilot_n === null || basis.pilot_n === undefined)) return s;
  return { ...s, d: basis.difference / sdUsed(basis) };
}

function recruit(s, n) {
  const keep = 1.0 - (s.dropout || 0);
  if (n[0] === null) return [null, null, up(n[2] / keep)];
  const a = up(n[0] / keep);
  const b = up(n[1] / keep);
  return [a, b, a + b];
}

function computed2(scenarios) {
  const out = [];
  const parts = [];
  for (const s of scenarios) {
    const e = effective(s);
    const basis = e !== s ? s.sd_basis : null;
    const used = basis !== null ? sdUsed(basis) : null;
    const n = sizes(e);
    const r = n !== null ? recruit(s, n) : null;
    out.push([s, n, r, used]);
    if (n === null) continue;
    const tail = used !== null ? " sd_used=" + used.toFixed(2) + " d=" + e.d.toFixed(3) : "";
    const drop = show(s.dropout || 0);
    if (n[0] === null) parts.push(s.scenario_id + ": total=" + n[2] + " recruit_total=" + r[2] + " dropout=" + drop + tail);
    else {
      parts.push(s.scenario_id + ": n1=" + n[0] + " n2=" + n[1] + " total=" + n[2] + " recruit1=" + r[0] + " recruit2=" +
        r[1] + " recruit_total=" + r[2] + " dropout=" + drop + tail);
    }
  }
  return [out, parts.join("; ")];
}



// At most n characters (code points), the last an ellipsis where it was cut. See gate.py.
function clip(text, n) {
  const chars = Array.from(text);
  return chars.length <= n ? text : chars.slice(0, n - 1).join("") + "…";
}


// One evidence item per scenario code could size. See gate.py.
function sizeItems(out) {
  const items = [];
  for (const [s, n, r, used] of out) {
    if (n === null) continue;
    const tail = used !== null ? " sd_used=" + used.toFixed(2) + " d=" + effective(s).d.toFixed(3) : "";
    const drop = show(s.dropout || 0);
    const detail = n[0] === null
      ? "total=" + n[2] + " recruit_total=" + r[2] + " dropout=" + drop + tail
      : "n1=" + n[0] + " n2=" + n[1] + " total=" + n[2] + " recruit1=" + r[0] + " recruit2=" + r[1] +
        " recruit_total=" + r[2] + " dropout=" + drop + tail;
    items.push({ ref: clip("sizes#" + show(s.scenario_id), 200), detail: clip(detail, 400) });
  }
  return items;
}

function clipped(problems) {
  return problems.map((p) => ({ ref: clip(p.ref, 200), detail: clip(p.detail, 400) }));
}

// The table's columns and their cells in code's words. See gate.py.
const REQUIRED = ["scenario", "completers_per_arm", "completers_total", "recruit_per_arm", "recruit_total"];
const OPTIONAL = ["power", "alpha", "dropout", "sd_used"];
const NOT_SIZED = "not computed in this run";

function byPort(gateInput, load, name) {
  for (const p of gateInput.extra_inputs || []) if (p.port === name) return load(p);
  return null;
}

function pct(x) {
  const t = Math.floor(x * 1000 + 0.5);
  return String(Math.floor(t / 10)) + (t % 10 === 0 ? "" : "." + String(t % 10)) + "%";
}

function cellNorm(text) {
  const t = String(text).replace(/(?<=[0-9]),(?=[0-9]{3})/g, "");
  return t.split(/\s+/).filter((w) => w.length > 0).join(" ").toLowerCase();
}

function expected(s, n, r, used) {
  const out = {
    scenario: s.label || "", power: pct(s.power || 0), alpha: show(s.alpha), dropout: pct(s.dropout || 0),
    sd_used: used !== null ? used.toFixed(2) : "not used",
  };
  if (n === null) {
    for (const k of ["completers_per_arm", "completers_total", "recruit_per_arm", "recruit_total"]) out[k] = NOT_SIZED;
  } else if (n[0] === null) {
    Object.assign(out, { completers_per_arm: "one group", completers_total: String(n[2]), recruit_per_arm: "one group", recruit_total: String(r[2]) });
  } else {
    Object.assign(out, {
      completers_per_arm: n[0] + " and " + n[1], completers_total: String(n[2]),
      recruit_per_arm: r[0] + " and " + r[1], recruit_total: String(r[2]),
    });
  }
  return out;
}

function check(gateInput, load) {
  const table = load(gateInput.target);
  const plan = byPort(gateInput, load, "mlx_power_plan");
  if (plan === null) return ["fail", 0, 1, [{ ref: "summary", detail: "missing_input" }, { ref: "mlx_power_plan", detail: "missing_input" }]];
  const scenarios = plan.scenarios || [];
  const [out] = computed2(scenarios);
  const problems = [];
  const warnings = [];
  const cols = (table.columns || []).map((c) => String(c.key));
  for (const k of REQUIRED) if (!cols.includes(k)) problems.push({ ref: "column#" + k, detail: "column_missing" });
  if (out.some((x) => x[3] !== null) && !cols.includes("sd_used")) problems.push({ ref: "column#sd_used", detail: "column_missing" });
  const seen = [];
  for (const k of cols) {
    if (!REQUIRED.concat(OPTIONAL).includes(k)) problems.push({ ref: "column#" + k, detail: "column_unknown" });
    else if (seen.includes(k)) problems.push({ ref: "column#" + k, detail: "column_twice" });
    seen.push(k);
  }
  if (/[0-9]/.test(table.title || "")) problems.push({ ref: "title", detail: "number_in_title" });
  for (const c of table.columns || []) if (/[0-9]/.test(c.label || "")) problems.push({ ref: "column#" + String(c.key), detail: "number_in_label" });
  const rows = new Map();
  for (const row of table.rows || []) {
    const ref = String(row.ref);
    if (rows.has(ref)) problems.push({ ref: "row#" + ref, detail: "row_twice" });
    else rows.set(ref, row);
  }
  const ids = scenarios.map((s) => String(s.scenario_id));
  for (const ref of rows.keys()) if (!ids.includes(ref)) problems.push({ ref: "row#" + ref, detail: "row_unknown" });
  for (const [s, n, r, used] of out) {
    const sid = String(s.scenario_id);
    if (n === null) warnings.push({ ref: "row#" + sid, detail: "scenario_not_sized" });
    const row = rows.get(sid);
    if (row === undefined) {
      problems.push({ ref: "row#" + sid, detail: "row_missing" });
      continue;
    }
    const cells = row.cells || [];
    if (cells.length !== cols.length) {
      problems.push({ ref: "row#" + sid, detail: "cells_not_columns" });
      continue;
    }
    const want = expected(s, n, r, used);
    cols.forEach((k, i) => {
      if (Object.prototype.hasOwnProperty.call(want, k) && cellNorm(cells[i]) !== cellNorm(want[k])) {
        problems.push({ ref: "sizes#" + sid + "#" + k, detail: "cell_mismatch; expected=" + want[k] });
      }
    });
  }
  const summary = { ref: "summary", detail: "scenarios=" + scenarios.length + " rows=" + rows.size + " problems=" + problems.length + " warnings=" + warnings.length };
  const status = problems.length ? "fail" : warnings.length ? "warn" : "pass";
  return [status, scenarios.length, problems.length, [summary, ...clipped(problems), ...clipped(warnings)]];
}

run(GATE_ID, GATE_REF, check);
