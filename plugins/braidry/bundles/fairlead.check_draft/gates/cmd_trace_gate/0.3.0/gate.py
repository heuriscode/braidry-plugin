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


# Numbers: digits with thousands commas and a decimal part, not inside a word (Q3, H2O, COVID-19), not an
# ordinal (3rd). The key sets aside commas, leading and trailing zeros, the sign and a percent sign.
NUMBER = re.compile(r"(?<![A-Za-z0-9_])(?<![A-Za-z]-)(?:[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|\.[0-9]+)(?![0-9])"
                    r"(?!(?:st|nd|rd|th)(?![A-Za-z]))")
YEAR = re.compile(r"[0-9]{4}")
MIN_FRAGMENT = 6
FRAGMENT_SPLIT = re.compile(r"\[\.\.\.\]|\.\.\.|…")


def num_key(literal):
    s = literal.replace(",", "")
    if s.startswith("."):
        s = "0" + s
    whole, _, frac = s.partition(".")
    whole = whole.lstrip("0") or "0"
    frac = frac.rstrip("0")
    return whole + ("." + frac if frac else "")


def numbers(text):
    """[(literal, key)] for every number in the text, in order."""
    return [(m.group(0), num_key(m.group(0))) for m in NUMBER.finditer(text)]


def fold(text):
    """Line-end hyphens joined, then folded (gatekit ascii_fold), as quote_gate 0.3.0 folds a saved text."""
    return ascii_fold(re.sub(r"-[ \t]*\r?\n[ \t]*", "", text))


def named(gate_input, name):
    """A named extra input; a missing one is a protocol error (exit 4), never a silent skip."""
    for port in gate_input.get("extra_inputs") or []:
        if port.get("port") == name:
            return port
    raise KeyError("missing input port " + name)


def optional(gate_input, name):
    """A named extra input, or None when the step was not served it."""
    for port in gate_input.get("extra_inputs") or []:
        if port.get("port") == name:
            return port
    return None


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


GATE_ID = "cmd_trace_gate"
GATE_REF = "cmd_trace_gate@0.3.0"
ORDER = ["quote_not_in_text", "number_not_in_text", "number_untraced", "quote_not_in_part", "number_not_in_part",
         "quote_unchecked", "number_unchecked", "quote_unsourced", "nothing_to_check"]
FAILS = ("quote_not_in_text", "number_not_in_text", "number_untraced")


def checkable(quote):
    return any(len(fold(f)) >= MIN_FRAGMENT for f in FRAGMENT_SPLIT.split(quote))


def quote_in(quote, text):
    haystack = fold(text)
    for fragment in FRAGMENT_SPLIT.split(quote):
        needle = fold(fragment)
        if len(needle) >= MIN_FRAGMENT and needle not in haystack:
            return False
    return True


def check(gate_input, load):
    inventory = load(gate_input["target"])
    texts = load(named(gate_input, "source_texts"))
    strict = (gate_input.get("config") or {}).get("every_number_traces") is True
    saved = {}
    for entry in texts.get("items") or []:
        sid = id_str(entry.get("source_id"))
        if sid not in saved and isinstance(entry.get("text"), str):
            saved[sid] = entry
    keys = {}
    counts = {k: 0 for k in ORDER}
    failures = []
    warnings = []

    def flag(outcome, ref):
        counts[outcome] += 1
        fail = outcome in FAILS or (strict and outcome == "quote_unsourced")
        (failures if fail else warnings).append({"ref": ref, "detail": outcome})

    checked = 0
    uncited = 0
    labels = 0
    for item in inventory.get("items") or []:
        kind = item.get("kind")
        if kind not in ("quote", "number"):
            continue
        if kind == "number":
            # A number that only labels something (Recommendation 2, a list's 1.) is not a number to trace.
            value = numbers(item.get("value") or "")
            text = item.get("text") or ""
            if value and value[0][1] in {k for _, k in numbers(text)} and value[0][1] not in {
                    k for _, k in numbers(unlabel(text))}:
                labels += 1
                continue
        ref = id_str(item.get("item_id")) + "@" + id_str(item.get("paragraph_id"))
        sources = [id_str(s) for s in item.get("source_ids") or []]
        if not sources:
            if kind == "quote":
                flag("quote_unsourced", ref)
            elif strict:
                flag("number_untraced", ref)
            else:
                uncited += 1
            continue
        checked += 1
        have = [saved[s] for s in sources if s in saved]
        if kind == "quote":
            text = item.get("text") or ""
            if not checkable(text):
                flag("quote_unchecked", ref)
                continue
            if any(quote_in(text, h["text"]) for h in have):
                continue
        else:
            found = numbers(item.get("value") or "")
            if found:
                for h in have:
                    sid = id_str(h.get("source_id"))
                    if sid not in keys:
                        keys[sid] = {k for _, k in numbers(h["text"])}
                if any(found[0][1] in keys[id_str(h.get("source_id"))] for h in have):
                    continue
        levels = [h.get("read_level") for h in have]
        if "full_text" in levels:
            flag(kind + "_not_in_text", ref)
        elif "full_text_partial" in levels:
            flag(kind + "_not_in_part", ref)
        else:
            flag(kind + "_unchecked", ref)
    # No quote or number with a source to trace is never a pass (user test phase 2B).
    if checked == 0:
        flag("nothing_to_check", "inventory")
    failed = len(failures)
    status = "fail" if failed else ("warn" if warnings else "pass")
    unchecked = counts["quote_unchecked"] + counts["number_unchecked"]
    summary = " ".join("%s=%d" % (k, counts[k]) for k in ORDER) + " uncited=%d labels=%d unchecked=%d of %d" % (
        uncited, labels, unchecked, checked)
    return status, checked, failed, [{"ref": "summary", "detail": summary}] + failures + warnings


run(GATE_ID, GATE_REF, check)
