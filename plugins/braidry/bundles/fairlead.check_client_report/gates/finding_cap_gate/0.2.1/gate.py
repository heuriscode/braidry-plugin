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


GATE_ID = "finding_cap_gate"
GATE_REF = "finding_cap_gate@0.2.1"
ORDER = ["missing_input", "cap_reached"]
FINDINGS = "findings_v0_2"


LARGEST = 2**53 - 1


def whole(value):
    """A count as kit findings 0.2 states it: a whole number, not a boolean. A float with no fraction counts, as
    JavaScript reads it the same once parsed. 0.2.1 (ChoiceLab design review 9): a count below 0 or above 2^53 - 1,
    the largest whole number both runtimes hold exactly, is not a count. Anything else is None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer() and abs(value) <= LARGEST:
        value = int(value)
    if isinstance(value, int) and 0 <= value <= LARGEST:
        return value
    return None


def check(gate_input, load):
    """Ruling 76 (Daniel, 2026-10-24): a checker's finding cap is never silent. A checker that reported as many
    findings as its cap allows, or recorded more it did not report (`truncated.more_found`), fails `cap_reached`, so
    the person is told it stopped early. The cap comes from the pack. 0.2.0 (ChoiceLab design review 8): every
    findings document the gate is given is checked (the target and each extra input of kit findings 0.2), each named
    by its port, so one step covers several checkers; a `more_found` that is not a whole number fails
    `missing_input`, the same in both runtimes."""
    config = gate_input.get("config") or {}
    cap = config.get("cap")
    ports = [gate_input["target"]] + [p for p in gate_input.get("extra_inputs") or [] if p.get("contract") == FINDINGS]
    evidence = []
    failed = 0
    for port in ports:
        doc = load(port)
        name = id_str(port.get("port"))
        found = len(doc.get("findings") or [])
        raw = (doc.get("truncated") or {}).get("more_found", 0)
        more = whole(raw)
        evidence.append({"ref": "summary", "detail": "port=%s found=%d more_found=%s cap=%s"
                         % (name, found, id_str(more if more is not None else "invalid"), id_str(cap))})
        if more is None:
            failed += 1
            evidence.append({"ref": name + "#more_found", "detail": "missing_input"})
        elif (whole(cap) is not None and found >= whole(cap)) or more > 0:
            failed += 1
            evidence.append({"ref": name, "detail": "cap_reached"})
    return ("fail" if failed else "pass"), len(ports), failed, evidence


run(GATE_ID, GATE_REF, check)
