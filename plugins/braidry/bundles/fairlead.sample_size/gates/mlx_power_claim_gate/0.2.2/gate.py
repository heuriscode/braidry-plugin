# --- gatekit 0.4.0 (Python) --- embedded verbatim in every Python gate; tests/braids/test_gatekit.py checks it.
# Gate I/O protocol gate_io/0.1 (BRAIDS_SPEC §3.8). Standard library only, so a gate is one self-contained file.
import hashlib
import json
import os
import re
import sys
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL = "gate_io/0.1"
EXIT = {"pass": 0, "fail": 1, "warn": 2, "skipped": 3}


class NetworkUnavailable(Exception):
    """A network precondition is missing: the gate exits 3 (skipped) with the host in its evidence."""


def canonical(value):
    """Compact JSON with keys sorted by UTF-16 code units; integers, strings, booleans, null, lists and dicts only."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError("gatekit.canonical: unsupported type " + type(value).__name__)


def fp_raw(data):
    return "raw:sha256:" + hashlib.sha256(data).hexdigest()


def fp_jcs(value):
    return "jcs1:sha256:" + hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def pct(text, safe=""):
    """Percent-encode UTF-8 bytes; only A-Z a-z 0-9 - . _ ~ and the characters in `safe` stay as they are."""
    out = []
    for byte in text.encode("utf-8"):
        ch = chr(byte)
        if ch.isascii() and (ch.isalnum() or ch in "-._~" or ch in safe):
            out.append(ch)
        else:
            out.append("%%%02X" % byte)
    return "".join(out)


ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " "}


def decode_entities(text):
    def one(m):
        body = m.group(1)
        if body.startswith("#x") or body.startswith("#X"):
            return chr(int(body[2:], 16))
        if body.startswith("#"):
            return chr(int(body[1:]))
        return ENTITIES.get(body, m.group(0))

    return re.sub(r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-z]{2,6});", one, text)


def ascii_fold(text):
    """NFKD, drop combining marks, lowercase A-Z only, everything outside a-z 0-9 becomes one space."""
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.category(c).startswith("M"))
    text = "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in text)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def norm_text(text):
    """Source text for quote matching: entities, tags and line-end hyphens removed, then folded."""
    text = decode_entities(text)
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"-[ \t]*\r?\n[ \t]*", "", text)
    return ascii_fold(text)


def similarity(a, b):
    """Integer percent similarity of two folded strings: floor(100 * (m - levenshtein) / m), m the longer length."""
    a, b = ascii_fold(a), ascii_fold(b)
    if not a and not b:
        return 0
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    m = max(len(a), len(b))
    return (100 * (m - prev[len(b)])) // m



_ASCII_WS = " \t\n\r\x0b\x0c"


def id_str(value):
    """An id as text, the same in both runtimes: None is "", booleans are true/false, integers in decimal."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, str):
        return value
    raise TypeError("gatekit.id_str: not an id: " + type(value).__name__)


def strip_ascii(text):
    """Strip ASCII whitespace only (str.strip and String.trim disagree on Unicode spaces)."""
    return text.strip(_ASCII_WS)



# Kit documents (gatekit 0.3.0): Fairlead-assigned ids and computed change sets (R1 D-1, D-2).
_KIT_PREFIX = {"section": "sec", "paragraph": "par", "claim": "clm", "figure": "fig"}
_KIT_ID_KEY = {"section": "section_id", "paragraph": "paragraph_id", "claim": "claim_id", "figure": "figure_id"}


def _kit_items(doc):
    """(kind, node, parent id, position path) for every id-bearing item, in document order."""
    out = []
    for si, sec in enumerate(doc.get("sections") or []):
        out.append(("section", sec, None, "s" + str(si)))
        for pi, par in enumerate(sec.get("paragraphs") or []):
            ppath = "s" + str(si) + ".p" + str(pi)
            out.append(("paragraph", par, sec.get("section_id"), ppath))
            for ci, cl in enumerate(par.get("claims") or []):
                out.append(("claim", cl, par.get("paragraph_id"), ppath + ".c" + str(ci)))
            for fi, fg in enumerate(par.get("figures") or []):
                out.append(("figure", fg, par.get("paragraph_id"), ppath + ".f" + str(fi)))
    return out


def assign_ids(prev, doc, salt):
    """A copy of `doc` with an id on every new item, and the problems: minted_id (an id not in `prev`) and
    duplicate_id. Ids are deterministic for a given salt and position."""
    out = json.loads(json.dumps(doc))
    known = set()
    if prev is not None:
        for kind, node, _parent, _path in _kit_items(prev):
            known.add(node.get(_KIT_ID_KEY[kind]))
    problems = []
    seen = set()
    items = _kit_items(out)
    for kind, node, _parent, _path in items:
        item_id = node.get(_KIT_ID_KEY[kind])
        if item_id is None:
            continue
        if item_id in seen:
            problems.append("duplicate_id:" + item_id)
        elif item_id not in known:
            problems.append("minted_id:" + item_id)
        seen.add(item_id)
    taken = known | seen
    for kind, node, _parent, path in items:
        key = _KIT_ID_KEY[kind]
        if node.get(key) is not None:
            continue
        n = 0
        while True:
            digest = hashlib.sha256((salt + "|" + kind + "|" + path + "|" + str(n)).encode("utf-8")).hexdigest()
            candidate = _KIT_PREFIX[kind] + "_" + digest[:8]
            if candidate not in taken:
                break
            n += 1
        node[key] = candidate
        taken.add(candidate)
    return out, problems


def _kit_num(value):
    """A number as JavaScript's String() writes it, so both runtimes show figures identically."""
    if isinstance(value, int):
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise TypeError("gatekit: non-finite number")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mant, _sep, exp = repr(abs(value)).partition("e")
    whole, _dot, frac = mant.partition(".")
    raw = whole + frac
    point = len(whole) + (int(exp) if exp else 0)
    lead = len(raw) - len(raw.lstrip("0"))
    digits = raw[lead:].rstrip("0")
    n, k = point - lead, len(digits)
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        text = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        text = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + text


def _kit_same(a, b):
    """Structural equality on JSON values; numbers compare by value, booleans only with booleans."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_kit_same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return sorted(a) == sorted(b) and all(_kit_same(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def _kit_content(kind, node):
    if kind == "section":
        return {"heading": node.get("heading")}
    if kind == "paragraph":
        return {"text": node.get("text")}
    if kind == "claim":
        return {"text": node.get("text"), "kind": node.get("kind"), "support": node.get("support")}
    keys = ("value", "unit", "source_id", "run_ref", "anchor")
    return {k: node.get(k) for k in keys}


def _kit_show(kind, node):
    if kind == "section":
        return node.get("heading")
    if kind in ("paragraph", "claim"):
        return node.get("text")
    value = node.get("value")
    shown = value if isinstance(value, str) else ("" if value is None else _kit_num(value))
    return shown + (" " + node.get("unit") if node.get("unit") else "")


def _kit_index(doc):
    index = {}
    order = []
    for kind, node, parent, _path in _kit_items(doc):
        item_id = node.get(_KIT_ID_KEY[kind])
        if item_id is None:
            raise ValueError("gatekit.change_set: unassigned id in a " + kind)
        index[item_id] = (kind, node, parent)
        order.append(item_id)
    return index, order


def change_set(before, after):
    """{items, reordered}: every added, removed or changed item by id; reordering alone is only a flag."""
    b_index, b_order = _kit_index(before)
    a_index, a_order = _kit_index(after)
    items = []
    for item_id in a_order:
        kind, node, parent = a_index[item_id]
        if item_id not in b_index:
            items.append({"id": item_id, "kind": kind, "change": "added", "fields": [], "before": None,
                          "after": _kit_show(kind, node)})
            continue
        _kind, old, old_parent = b_index[item_id]
        new_c, old_c = _kit_content(kind, node), _kit_content(kind, old)
        fields = [k for k in new_c if not _kit_same(new_c[k], old_c[k])]
        if parent != old_parent:
            fields.append("parent")
        fields.sort()
        if fields:
            items.append({"id": item_id, "kind": kind, "change": "changed", "fields": fields,
                          "before": _kit_show(kind, old), "after": _kit_show(kind, node)})
    for item_id in b_order:
        if item_id not in a_index:
            kind, old, _parent = b_index[item_id]
            items.append({"id": item_id, "kind": kind, "change": "removed", "fields": [],
                          "before": _kit_show(kind, old), "after": None})
    common_b = [i for i in b_order if i in a_index]
    common_a = [i for i in a_order if i in b_index]
    return {"items": items, "reordered": common_b != common_a}



# Citations (gatekit 0.4.0; R1 D-4): a bracket starting "[@" is parsed strictly; any other bracket is prose.
_CITE_ID = r"[A-Za-z0-9_](?:[A-Za-z0-9_.:-]*[A-Za-z0-9_])?"
_CITE_PART = re.compile("@(" + _CITE_ID + r")(?:, (?:p|pp|ch|sec|para)\. [^;\]]{1,40})?")
_CITE_POSSIBLE = re.compile(r"(?:^|[ ;(])@[A-Za-z0-9_]")


def parse_citations(text):
    """{markers: [{text, ids}], malformed: [text], possible: [text]} in order of appearance."""
    markers = []
    malformed = []
    possible = []
    pos = 0
    while True:
        i = text.find("[", pos)
        if i < 0:
            break
        j = text.find("]", i + 1)
        if text.startswith("[@", i):
            if j < 0:
                malformed.append(text[i : i + 120])
                break
            ids = []
            ok = True
            for part in text[i + 1 : j].split(";"):
                m = _CITE_PART.fullmatch(strip_ascii(part))
                if not m:
                    ok = False
                    break
                ids.append(m.group(1))
            if ok:
                markers.append({"text": text[i : j + 1], "ids": ids})
            else:
                malformed.append(text[i : j + 1])
            pos = j + 1
            continue
        if j < 0:
            break
        inner = text.find("[", i + 1, j)
        if inner >= 0:
            pos = inner
            continue
        if _CITE_POSSIBLE.search(text[i + 1 : j]):
            possible.append(text[i : j + 1])
        pos = j + 1
    return {"markers": markers, "malformed": malformed, "possible": possible}


def fetch(gate_id, url):
    """GET url. Returns (status, body). Replays from FAIRLEAD_CASSETTES/<gate_id>/<hex>.json when that is set;
    a missing cassette is an error unless FAIRLEAD_CASSETTES_RECORD=1, which records it from the network."""
    cassettes = os.environ.get("FAIRLEAD_CASSETTES")
    path = None
    if cassettes:
        name = fp_jcs({"method": "GET", "url": url}).split(":")[-1] + ".json"
        path = os.path.join(cassettes, gate_id, name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                c = json.load(fh)
            return c["response"]["status"], c["response"]["body"]
        if os.environ.get("FAIRLEAD_CASSETTES_RECORD") != "1":
            raise RuntimeError("missing cassette for " + url)
    req = urllib.request.Request(url, headers={"User-Agent": "fairlead-" + gate_id + "/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, ctype, body = resp.status, resp.headers.get("Content-Type", ""), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        status, ctype, body = err.code, err.headers.get("Content-Type", ""), err.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError):
        raise NetworkUnavailable(urllib.parse.urlparse(url).hostname or url) from None
    if path:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        cassette = {"gate_ref": gate_id, "request": {"method": "GET", "url": url},
                    "response": {"status": status, "content_type": ctype, "body": body}}
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(cassette, indent=1, ensure_ascii=False) + "\n")
    return status, body


def _run(gate_id, gate_ref, check):
    args = sys.argv[1:]
    if len(args) != 4 or args[0] != "--input" or args[2] != "--out":
        sys.stderr.write("usage: gate --input <input.json> --out <result.json>\n")
        return 4
    with open(args[1], "rb") as fh:
        gate_input = json.loads(fh.read().decode("utf-8"))
    if gate_input.get("protocol") != PROTOCOL:
        sys.stderr.write("unsupported protocol\n")
        return 4
    ports = ([gate_input["target"]] if gate_input.get("target") else []) + list(gate_input.get("extra_inputs") or [])
    raw = {}
    for port in ports:
        with open(port["path"], "rb") as fh:
            raw[port["path"]] = fh.read()

    def load(port):
        return json.loads(raw[port["path"]].decode("utf-8"))

    try:
        status, checked, failed, evidence = check(gate_input, load)
    except NetworkUnavailable as exc:
        status, checked, failed = "skipped", 0, 0
        evidence = [{"ref": "network", "detail": "network unavailable: " + str(exc)}]
    with open(os.path.abspath(__file__), "rb") as fh:
        script_fp = fp_raw(fh.read())
    result = {"gate_id": gate_id, "gate_ref": gate_ref, "status": status, "checked": checked, "failed": failed,
              "script_fingerprint": script_fp,
              "input_fingerprints": [fp_raw(raw[p["path"]]) for p in ports],
              "evidence": evidence[:50]}
    with open(args[3], "w", encoding="utf-8", newline="\n") as fh:
        fh.write(canonical(result))
    return EXIT[status]


def run(gate_id, gate_ref, check):
    """gate_io/0.1 wrapper. check(gate_input, load) returns (status, checked, failed, evidence).
    Exit 0 to 3 is the verdict; any other failure exits 4, which the runner counts as an error."""
    try:
        code = _run(gate_id, gate_ref, check)
    except Exception:
        traceback.print_exc()
        code = 4
    sys.exit(code)
# --- end gatekit ---


# Number context (number_context.py, user test phase 2C): dates, numbering labels and list numbers are not figures;
# the person's own figures are backed.
NUM_DATES = re.compile(r"(?<![0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}(?![0-9])|(?<![0-9.,/-])[0-9]{1,2}([/-])[0-9]{1,2}\1(?:[0-9]{4}|[0-9]{2})(?![0-9])|(?<![0-9])(?:19|20)[0-9]{2}[-–/](?:(?:19|20)[0-9]{2}|[0-9]{2})(?![0-9])|(?<![A-Za-z0-9_.,])[0-3]?[0-9](?:st|nd|rd|th)?[ \t]+(?:of[ \t]+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)(?![A-Za-z])|(?<![A-Za-z])(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[.]?[ \t]+[0-3]?[0-9](?:st|nd|rd|th)?(?![0-9])(?![ \t]*(?:%|per[ \t]cent|percent))")
NUM_LABELS = re.compile(r"(?<![A-Za-z])(?:[Rr]ecommendations?|[Ff]igures?|[Ff]igs?\.|[Tt]ables?|[Ss]ections?|[Cc]hapters?|[Aa]ppendix|[Aa]ppendices|[Ii]tems?|[Ss]teps?|[Oo]ptions?|[Pp]arts?|[Bb]oxes|[Bb]ox|[Pp]aragraphs?|[Pp]aras?\.|[Cc]lauses?|[Ss]chedules?|[Aa]nnex(?:es)?|[Aa]ttachments?|[Qq]uestions?|[Ff]indings?|[Aa]ctions?|[Pp]rinciples?|[Oo]bjectives?|[Pp]hases?|[Ss]tages?|[Vv]olumes?|[Vv]ols?\.|[Nn]os?\.|[Pp]ages?|[Pp]p?\.|[Ss]cenarios?|[Bb]ands?|[Tt]iers?|[Ll]evels?|[Rr]ounds?|[Ww]aves?|[Aa]rms?|[Cc]ohorts?|[Gg]roups?)[ \t]+[0-9]+(?:\.[0-9]+)*[A-Za-z]?(?:[ \t]*,[ \t]*[0-9]+(?:\.[0-9]+)*[A-Za-z]?(?=[ \t]*(?:,|and[ \t]|or[ \t]|&)))*(?:[ \t]*,?[ \t]*(?:and|or|to|&|-|–)[ \t]*[0-9]+(?:\.[0-9]+)*[A-Za-z]?)?")
NUM_LIST = re.compile(r"(^|\n[ \t]*|[.;:!?][ \t]+)\(?[0-9]{1,3}[.)](?=[ \t])")


def unlabel(text):
    """The text with dates, numbering labels and list numbers blanked, so their digits are not numbers."""
    text = NUM_DATES.sub(" ", text)
    text = NUM_LABELS.sub(" ", text)
    return NUM_LIST.sub(lambda m: m.group(1) + " ", text)


def person_texts(focus, direction):
    """Every text and number in the agreed focus and the person's latest direction: the person's own words."""
    out = []

    def walk(value):
        if value is None or isinstance(value, bool):
            return
        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, (int, float)):
            out.append(_kit_num(value))
        elif isinstance(value, list):
            for v in value:
                walk(v)
        elif isinstance(value, dict):
            for k in sorted(value, key=lambda k: k.encode("utf-16-be")):
                walk(value[k])

    walk(focus)
    if isinstance(direction, dict):
        walk(direction.get("text"))
    return out


import math

GATE_ID = "mlx_power_claim_gate"
GATE_REF = "mlx_power_claim_gate@0.2.2"
PLAN = "mlx_power_plan_v0_2"
INPUTS = ["alpha", "power", "sides", "allocation_ratio", "d", "p1", "p2", "event_rate", "odds_ratio", "r2_other"]
BRACKET = re.compile(r"\[([^\[\]]*)\]")
SOURCE_PART = re.compile(r"@?[A-Za-z][A-Za-z0-9_.:-]*(?:, ?(?:p|pp|ch|sec|para)\. ?[^;\]]{1,40})?")
# A number with its sign and percent sign. Digits joined to a word (H1, x2) are part of it. See gate.js.
NUMBER = re.compile("(?<![A-Za-z0-9_.])([-−]?)([0-9]+(?:,[0-9]{3})*(?:[.][0-9]+)?|[.][0-9]+)(%?)(?![A-Za-z0-9_])")
YEAR = re.compile("[0-9]{4}")


def show(value):
    """A value as text, the same in both runtimes."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


# Wichura, M. J. (1988). Algorithm AS 241. Applied Statistics 37(3), 477-484.
A = [2.5090809287301226727e+3, 3.3430575583588128105e+4, 6.7265770927008700853e+4, 4.5921953931549871457e+4, 1.3731693765509461125e+4, 1.9715909503065514427e+3, 1.3314166789178437745e+2, 3.3871328727963666080e+0]
B = [5.2264952788528545610e+3, 2.8729085735721942674e+4, 3.9307895800092710610e+4, 2.1213794301586595867e+4, 5.3941960214247511077e+3, 6.8718700749205790830e+2, 4.2313330701600911252e+1, 1.0]
C = [7.74545014278341407640e-4, 2.27238449892691845833e-2, 2.41780725177450611770e-1, 1.27045825245236838258e+0, 3.64784832476320460504e+0, 5.76949722146069140550e+0, 4.63033784615654529590e+0, 1.42343711074968357734e+0]
D = [1.05075007164441684324e-9, 5.47593808499534494600e-4, 1.51986665636164571966e-2, 1.48103976427480074590e-1, 6.89767334985100004550e-1, 1.67638483018380384940e+0, 2.05319162663775882187e+0, 1.0]
E = [2.01033439929228813265e-7, 2.71155556874348757815e-5, 1.24266094738807843860e-3, 2.65321895265761230930e-2, 2.96560571828504891230e-1, 1.78482653991729133580e+0, 5.46378491116411436990e+0, 6.65790464350110377720e+0]
F = [2.04426310338993978564e-15, 1.42151175831644588870e-7, 1.84631831751005468180e-5, 7.86869131145613259100e-4, 1.48753612908506148525e-2, 1.36929880922735805310e-1, 5.99832206555887937690e-1, 1.0]


def horner(cs, r):
    acc = cs[0]
    for c in cs[1:]:
        acc = acc * r + c
    return acc


def z(p):
    """The standard normal quantile at p (AS 241)."""
    q = p - 0.5
    if abs(q) <= 0.425:
        r = 0.180625 - q * q
        return horner(A, r) * q / horner(B, r)
    r = p if q <= 0.0 else 1.0 - p
    r = math.sqrt(-math.log(r))
    if r <= 5.0:
        r = r - 1.6
        x = horner(C, r) / horner(D, r)
    else:
        r = r - 5.0
        x = horner(E, r) / horner(F, r)
    return -x if q < 0.0 else x


def up(x):
    return int(math.ceil(x - 1e-9))


def sizes(s):
    """(n1, n2, total) for a scenario, or (None, None, total) for a regression; None where it cannot be had."""
    family = s.get("family")
    za = z(1.0 - s["alpha"] / s["sides"])
    zb = z(s["power"])
    zz = (za + zb) * (za + zb)
    if family == "two_means":
        d, r = s["d"], s["allocation_ratio"]
        if d == 0:
            return None
        n1 = (1.0 + 1.0 / r) * zz / (d * d)
        a, b = up(n1), up(r * n1)
        return a, b, a + b
    if family == "two_proportions":
        p1, p2, r = s["p1"], s["p2"], s["allocation_ratio"]
        if p1 == p2:
            return None
        pbar = (p1 + r * p2) / (1.0 + r)
        x = za * math.sqrt(pbar * (1.0 - pbar) * (1.0 + 1.0 / r))
        y = zb * math.sqrt(p1 * (1.0 - p1) + p2 * (1.0 - p2) / r)
        n1 = (x + y) * (x + y) / ((p1 - p2) * (p1 - p2))
        a, b = up(n1), up(r * n1)
        return a, b, a + b
    if family == "logistic_continuous":
        if s["odds_ratio"] == 1:
            return None
        beta = math.log(s["odds_ratio"])
        rate = s["event_rate"]
        n = zz / (rate * (1.0 - rate) * beta * beta) / (1.0 - s["r2_other"])
        return None, None, up(n)
    return None


def computed(scenarios):
    """[(scenario, sizes or None)], and the summary text of every computed size."""
    out, parts = [], []
    for s in scenarios:
        n = sizes(s)
        out.append((s, n))
        if n is None:
            continue
        if n[0] is None:
            parts.append("%s: total=%d" % (s.get("scenario_id"), n[2]))
        else:
            parts.append("%s: n1=%d n2=%d total=%d" % (s.get("scenario_id"), n[0], n[1], n[2]))
    return out, "; ".join(parts)


LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
           -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
           1.5056327351493116e-7]


def log_gamma(a):
    """ln Gamma(a) for a > 0.5 (Lanczos, g = 7)."""
    a -= 1.0
    x = LANCZOS[0]
    for i in range(1, 9):
        x += LANCZOS[i] / (a + i)
    t = a + 7.5
    return 0.9189385332046727 + (a + 0.5) * math.log(t) - t + math.log(x)


def lower_gamma(a, x):
    """The regularised lower incomplete gamma P(a, x): a series below a + 1, else a continued fraction."""
    if x <= 0.0:
        return 0.0
    front = math.exp(-x + a * math.log(x) - log_gamma(a))
    if x < a + 1.0:
        term = 1.0 / a
        total = term
        for n in range(1, 1000):
            term = term * x / (a + n)
            total += term
            if term < total * 1e-16:
                break
        return total * front
    b = x + 1.0 - a
    c = 1e300
    d = 1.0 / b
    h = d
    for i in range(1, 1000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        d = 1e-300 if abs(d) < 1e-300 else d
        c = b + an / c
        c = 1e-300 if abs(c) < 1e-300 else c
        d = 1.0 / d
        step = d * c
        h *= step
        if abs(step - 1.0) < 1e-16:
            break
    return 1.0 - front * h


def chi2_lower(p, k):
    """The chi-square quantile at lower-tail p with k degrees of freedom, by bisection on P(k/2, x/2)."""
    lo, hi = 0.0, k + 100.0 * math.sqrt(2.0 * k) + 100.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if lower_gamma(k / 2.0, mid / 2.0) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def sd_used(basis):
    """The SD a d is computed from: as given, or its one-sided upper confidence limit from the pilot."""
    if basis.get("upper_limit") is None:
        return basis["sd"]
    n = basis.get("pilot_n")
    return basis["sd"] * math.sqrt((n - 1) / chi2_lower(1.0 - basis["upper_limit"], n - 1))


def effective(s):
    """The scenario with d computed in code from its sd_basis, where it has one."""
    basis = s.get("sd_basis")
    if s.get("family") != "two_means" or not isinstance(basis, dict):
        return s
    if basis.get("upper_limit") is not None and basis.get("pilot_n") is None:
        return s
    out = dict(s)
    out["d"] = basis["difference"] / sd_used(basis)
    return out


def recruit(s, n):
    """Recruitment after dropout, per arm and in total: each arm's n / (1 - dropout), rounded up."""
    keep = 1.0 - (s.get("dropout") or 0)
    if n[0] is None:
        return None, None, up(n[2] / keep)
    a, b = up(n[0] / keep), up(n[1] / keep)
    return a, b, a + b


def computed2(scenarios):
    """[(scenario, sizes, recruitment, sd used or None)], and the summary text of every computed figure."""
    out, parts = [], []
    for s in scenarios:
        e = effective(s)
        basis = s.get("sd_basis") if e is not s else None
        used = sd_used(basis) if basis is not None else None
        n = sizes(e)
        r = recruit(s, n) if n is not None else None
        out.append((s, n, r, used))
        if n is None:
            continue
        tail = (" sd_used=%.2f d=%.3f" % (used, e["d"])) if used is not None else ""
        drop = show(s.get("dropout") or 0)
        if n[0] is None:
            parts.append("%s: total=%d recruit_total=%d dropout=%s%s" % (s.get("scenario_id"), n[2], r[2], drop, tail))
        else:
            parts.append("%s: n1=%d n2=%d total=%d recruit1=%d recruit2=%d recruit_total=%d dropout=%s%s" % (
                s.get("scenario_id"), n[0], n[1], n[2], r[0], r[1], r[2], drop, tail))
    return out, "; ".join(parts)



def clip(text, n):
    """At most n characters, the last an ellipsis where it was cut."""
    return text if len(text) <= n else text[: n - 1] + "…"


def size_items(out):
    """One evidence item per scenario code could size: completers, recruitment after dropout, any SD limit."""
    items = []
    for s, n, r, used in out:
        if n is None:
            continue
        tail = (" sd_used=%.2f d=%.3f" % (used, effective(s)["d"])) if used is not None else ""
        drop = show(s.get("dropout") or 0)
        if n[0] is None:
            detail = "total=%d recruit_total=%d dropout=%s%s" % (n[2], r[2], drop, tail)
        else:
            detail = "n1=%d n2=%d total=%d recruit1=%d recruit2=%d recruit_total=%d dropout=%s%s" % (
                n[0], n[1], n[2], r[0], r[1], r[2], drop, tail)
        items.append({"ref": clip("sizes#" + show(s.get("scenario_id")), 200), "detail": clip(detail, 400)})
    return items


def clipped(problems):
    return [{"ref": clip(p["ref"], 200), "detail": clip(p["detail"], 400)} for p in problems]


def uncite(text):
    """The text with every source citation bracket blanked; other brackets stay."""

    def one(m):
        parts = m.group(1).split(";")
        return " " if all(SOURCE_PART.fullmatch(strip_ascii(p)) for p in parts) else m.group(0)

    return BRACKET.sub(one, text)


def near(a, b):
    return abs(a - b) <= 1e-9 * max(1.0, abs(b))


def check(gate_input, load):
    doc = load(gate_input["target"])
    plans = [p for p in gate_input.get("extra_inputs") or [] if p.get("contract") == PLAN]
    if not plans:
        return "fail", 0, 1, [{"ref": "summary", "detail": "numbers=0 unbacked=0 sized=0"},
                              {"ref": "mlx_power_plan", "detail": "missing_input"}]
    scenarios = load(plans[0]).get("scenarios") or []
    out, text = computed2(scenarios)
    allowed = [float(len(scenarios))]
    totals = []
    for s, n, r, used in out:
        for key in INPUTS + ["dropout"]:
            value = s.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                allowed.append(float(value))
        basis = s.get("sd_basis") or {}
        for key in ("difference", "sd", "pilot_n", "upper_limit"):
            value = basis.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                allowed.append(float(value))
        if used is not None:
            allowed += [round(used, 2), round(used, 1), round(effective(s)["d"], 2), round(effective(s)["d"], 3)]
        if n is not None:
            allowed += [float(v) for v in n if v is not None]
            allowed += [float(v) for v in r if v is not None]
            totals.append((s, n[2], r[2]))
    focus = None
    direction = None
    for p in gate_input.get("extra_inputs") or []:
        if p.get("contract") == "agreed_focus":
            focus = load(p)
        if p.get("contract") == "person_direction_v0_1":
            direction = load(p)
    # The person's own figures (their request, the focus they accepted, their latest direction) are backed.
    for t in person_texts(focus, direction):
        for m in NUMBER.finditer(t):
            allowed.append(float(m.group(2).replace(",", "")))
    found = 0
    seen = []
    problems = []
    for si, section in enumerate(doc.get("sections") or []):
        for pi, para in enumerate(section.get("paragraphs") or []):
            for m in NUMBER.finditer(unlabel(uncite(para.get("text") or ""))):
                found += 1
                sign, digits, percent = m.group(1), m.group(2), m.group(3)
                literal = sign + digits + percent
                value = float(digits.replace(",", "")) * (-1.0 if sign else 1.0)
                seen.append(value)
                year = not sign and not percent and YEAR.fullmatch(digits) is not None and 1900 <= value <= 2100
                backed = year or any(near(value, a) for a in allowed)
                if percent and not backed:
                    backed = any(near(value / 100.0, a) for a in allowed)
                if not backed:
                    problems.append({"ref": "section %d, paragraph %d: %s" % (si + 1, pi + 1, literal),
                                     "detail": "unbacked_number"})
    for s, total, recruited in totals:
        if not any(near(v, float(total)) for v in seen):
            problems.append({"ref": "scenario#" + str(s.get("scenario_id")), "detail": "total_not_stated"})
        if (s.get("dropout") or 0) > 0 and not any(near(v, float(recruited)) for v in seen):
            problems.append({"ref": "scenario#" + str(s.get("scenario_id")), "detail": "recruitment_not_stated"})
    sized = size_items(out)
    summary = {"ref": "summary", "detail": "numbers=%d unbacked=%d sized=%d" % (found, len(problems), len(sized))}
    return ("fail" if problems else "pass"), found, len(problems), [summary] + clipped(problems) + sized


run(GATE_ID, GATE_REF, check)
