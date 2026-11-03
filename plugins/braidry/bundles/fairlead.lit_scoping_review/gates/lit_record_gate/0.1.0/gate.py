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


# --- lit_record_gate 0.1.0 ---
GATE_ID = "lit_record_gate"
GATE_REF = "lit_record_gate@0.1.0"
ORDER = ["reading_level_stated", "count_hedged", "included_count_differs", "included_count_changed"]
FAILS = ORDER[:3]

WORDS = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty"
).split()
WORD_ALT = "|".join(sorted(WORDS, key=lambda w: (-len(w), w)))
NUM = r"(?:([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(\.[0-9]+)?(?![0-9a-z])|(" + WORD_ALT + r")(?![a-z0-9-]))"
HEDGES = ["approximately", "an estimated", "fewer than", "more than", "less than", "roughly", "nearly",
          "around", "almost", "approx.", "approx", "circa", "about", "some", "over"]
HEDGED = re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(h) for h in HEDGES) + r")[ \t\n]+" + NUM
                    + r"|(~)[ \t]*" + NUM)
NOUNS = set((
    "record records study studies source sources paper papers article articles duplicate "
    "duplicates near-duplicate near-duplicates hit hits result results item items work works "
    "report reports publication publications chapter chapters citation citations entry "
    "entries preprint preprints"
).split())
VERBS = set((
    "found identified retrieved returned screened excluded included removed examined assessed "
    "deduplicated located kept dropped read"
).split())
BE = {"were", "was", "are", "is", "been", "be", "had", "have", "has"}
STOPS = set((
    "in with from by for but nor to at on per across that which who than as between among "
    "into over under since during after before each a an the years year times"
).split())
LEAD_WORDS = NOUNS | VERBS | {"count", "counts", "reason", "reasons"}
ADJ = set("unique distinct eligible remaining additional relevant new further".split())
SCREEN_WORDS = set("screen screened screening deduplication deduplicated".split())
SENTENCE_MARK = ".!?\n"
SCALE = re.compile(r"[ \t]*(?:%|per[ \t-]?cent(?![a-z])|percent(?![a-z])"
                   r"|hundred|thousand|million|billion|trillion)")
TOKEN = re.compile(r"[ \t\n]*([a-z]+(?:-[a-z]+)*)")
WORD_TOKEN = re.compile(r"[a-z]+(?:-[a-z]+)*")
CLAUSE_END = re.compile(r"[ \t]*(?:\n|$|[.;,:)\]!?])")
CLAUSE_MARK = ".;:!?()[],\n"
LIST_ITEM = re.compile(r"[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+")
LINE_TAIL = re.compile(r"[ \t]*[.;,]?[ \t]*(?:\n|$)")

SP = "[ \t\n]+"
KINDS = "(?:work|works|source|sources|study|studies|record|records|paper|papers|article|articles|item|items" \
        "|report|reports|included work|included works|included source|included sources|included study" \
        "|included studies)"
FULL = "full(?:-| )texts?"
READING = [
    "(?:no|none of the) " + KINDS + " (?:was|were) (?:read|opened|obtained|retrieved) in full",
    "(?:none|nothing) (?:of them )?(?:was|were) read in full",
    "not (?:been )?read in full",
    "(?:no|without) " + FULL + " (?:reading|read|review|was read|were read)",
    FULL + " (?:was|were) not (?:read|opened)",
    "read (?:only )?(?:at|on|from) (?:the )?(?:abstract|abstracts|bibliographic record|record|records)"
    " (?:level|only)",
    "only (?:the )?abstracts? (?:was|were) read",
    "abstracts? only (?:was|were) read",
    "not read beyond (?:the )?(?:bibliographic )?record",
    "reading (?:was )?(?:limited|restricted) to (?:the )?(?:abstracts?|records?)",
]
READING_RE = [re.compile("(?<![a-z0-9])" + p.replace(" ", SP) + "(?![a-z0-9])") for p in READING]
# On the draft, which states reading levels from the evidence table, only a statement about the whole set.
WHOLE_RE = [READING_RE[i] for i in (0, 1, 3, 4, 6, 7, 9)]
INC_AFTER = re.compile(r"(?<![a-z0-9-])included[ \t]*(?::|=|\(n[ \t]*=)?[ \t]*" + NUM)
INC_BEFORE = re.compile(r"(?<![a-z0-9.,-])(?:([0-9]+)|(" + WORD_ALT
                        + r"))((?:[ \t]+[a-z]+(?:-[a-z]+)*){0,3}?)"
                        r"[ \t]+included(?![a-z])")
INC_BETWEEN = NOUNS | {"were", "was", "are", "have", "been", "finally", "all", "unique", "eligible"}


def ports_by_name(gate_input):
    out = {}
    target = [gate_input["target"]] if gate_input.get("target") else []
    for port in target + list(gate_input.get("extra_inputs") or []):
        out[port["port"]] = port
    return out


def named(gate_input, name):
    """A named input; a missing one is a protocol error (exit 4), never a silent skip."""
    port = ports_by_name(gate_input).get(name)
    if port is None:
        raise KeyError("missing input port " + name)
    return port


def optional(gate_input, name):
    return ports_by_name(gate_input).get(name)


def read_text(port):
    with open(port["path"], "rb") as fh:
        return fh.read().decode("utf-8")


def is_digit(ch):
    return unicodedata.category(ch) == "Nd"


def prepare(text):
    """NFKC; every decimal digit as its ASCII digit (its place in its aligned run of ten); ASCII lowercase; CR
    dropped."""
    text = unicodedata.normalize("NFKC", text).replace("\r", "")
    out = []
    for ch in text:
        if "0" <= ch <= "9" or not is_digit(ch):
            out.append(ch)
            continue
        cp = ord(ch)
        back = 0
        while cp - back - 1 >= 0 and is_digit(chr(cp - back - 1)):
            back += 1
        out.append(chr(48 + back % 10))
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in out)


def number_value(digits, word):
    if word:
        return WORDS.index(word)
    return int(digits.replace(",", ""))


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def tokens_after(text, pos, n):
    out = []
    while len(out) < n:
        m = TOKEN.match(text, pos)
        if not m:
            break
        out.append(m.group(1))
        pos = m.end()
    return out


def tokens_before(text, pos, n):
    start = pos
    while start > 0 and text[start - 1] not in CLAUSE_MARK:
        start -= 1
    return WORD_TOKEN.findall(text[start:pos])[-n:]


def lead_in(lines, index):
    """The nearest line above `index` that is neither blank nor a list item."""
    for k in range(index - 1, -1, -1):
        line = lines[k]
        if strip_ascii(line) == "" or LIST_ITEM.match(line):
            continue
        return line
    return ""


def names_records(text, start, end):
    """The sentence around text[start:end] names records or screening."""
    s = start
    while s > 0 and text[s - 1] not in SENTENCE_MARK:
        s -= 1
    e = end
    while e < len(text) and text[e] not in SENTENCE_MARK:
        e += 1
    return any(t in NOUNS or t in SCREEN_WORDS for t in WORD_TOKEN.findall(text[s:e]))


def counted_by(text, start, end):
    """What makes the hedged number at text[start:end] a count of records in the draft, or None."""
    after = tokens_after(text, end, 5)
    if after and after[0] in BE:
        if any(t in VERBS for t in after[1:5]):
            return after[0] + "-" + next(t for t in after[1:5] if t in VERBS)
    else:
        for i, t in enumerate(after[:3]):
            if t in NOUNS or (i == 0 and t in VERBS):
                return t
            if t in STOPS or t in BE:
                break
        if after and after[0] in ADJ and names_records(text, start, end):
            return after[0]
    if CLAUSE_END.match(text, end):
        for t in reversed(tokens_before(text, start, 4)):
            if t in NOUNS or t in VERBS:
                return t
    line_start = text.rfind("\n", 0, start) + 1
    if LIST_ITEM.match(text, line_start) and LINE_TAIL.match(text, end):
        lines = text.split("\n")
        lead = WORD_TOKEN.findall(lead_in(lines, text.count("\n", 0, start)))
        if any(t in LEAD_WORDS for t in lead):
            return "list"
    return None


def hedged_counts(text, record):
    """(position, hedge, number, counted by) for every hedged number that counts records: in the search
    record, every hedged number."""
    out = []
    for m in HEDGED.finditer(text):
        if m.group(1) is not None:
            hedge, digits, frac, word, num_end = m.group(1), m.group(2), m.group(3), m.group(4), m.end()
        else:
            hedge, digits, frac, word, num_end = "tilde", m.group(6), m.group(7), m.group(8), m.end()
        if record:
            out.append((m.start(), hedge, number_value(digits, word), "record"))
            continue
        if frac is not None or SCALE.match(text, num_end):
            continue
        by = counted_by(text, m.start(), num_end)
        if by is not None:
            out.append((m.start(), hedge, number_value(digits, word), by))
    return out


def reading_statements(text, patterns):
    found = []
    for rx in patterns:
        for m in rx.finditer(text):
            found.append((m.start(), m.end()))
    found.sort()
    kept = []
    for start, end in found:
        if kept and start < kept[-1][1]:
            continue
        kept.append((start, end))
    return kept


def included_statements(text):
    found = []
    for m in INC_AFTER.finditer(text):
        if m.group(2) is None:
            found.append((m.start(), number_value(m.group(1), m.group(3))))
    for m in INC_BEFORE.finditer(text):
        between = WORD_TOKEN.findall(m.group(3))
        if any(t not in INC_BETWEEN for t in between):
            continue
        nxt = tokens_after(text, m.end(), 1)
        if nxt and nxt[0] in NOUNS:
            continue
        found.append((m.start(), number_value(m.group(1), m.group(2))))
    found.sort()
    return found


def hedge_items(text, ref_of, record):
    return [(pos, {"ref": ref_of(pos), "detail": "count_hedged; hedge=" + ascii_fold(hedge) + "; n=" + str(n)
                   + "; by=" + by}) for pos, hedge, n, by in hedged_counts(text, record)]


def check(gate_input, load):
    """On the search record (s2r): every outcome fails. On the draft (s4r, s8r): the draft's reading-level and
    hedged-count statements fail; the search record is only compared with the register, which the writer may
    have changed since, as a warning (included_count_changed), unless the step that wrote the draft also wrote
    the search record (the reviser at s7): then its reading-level and hedged-number statements fail as at
    s2r."""
    record = prepare(read_text(named(gate_input, "search_record")))
    items = load(named(gate_input, "sources")).get("items") or []
    draft_port = optional(gate_input, "draft")
    counts = {k: 0 for k in ORDER}
    problems = []
    warns = []

    def at_line(pos):
        return "search_record:L" + str(line_of(record, pos))

    def scan(text, ref_of, record_mode):
        found = []
        for start, end in reading_statements(text, READING_RE if record_mode else WHOLE_RE):
            counts["reading_level_stated"] += 1
            words = ascii_fold(text[start:end])[:120]
            found.append((start, 0, {"ref": ref_of(start), "detail": "reading_level_stated; text=" + words}))
        for pos, item in hedge_items(text, ref_of, record_mode):
            counts["count_hedged"] += 1
            found.append((pos, 1, item))
        return found

    if draft_port is None:
        found = scan(record, at_line, True)
        for pos, n in included_statements(record):
            if n != len(items):
                counts["included_count_differs"] += 1
                detail = "included_count_differs; stated=" + str(n) + "; register=" + str(len(items))
                found.append((pos, 2, {"ref": at_line(pos), "detail": detail}))
        found.sort(key=lambda f: (f[0], f[1]))
        problems = [f[2] for f in found]
        checked = sum(1 for line in record.split("\n") if strip_ascii(line) != "")
    else:
        checked = 0
        draft = load(draft_port)
        for si, sec in enumerate(draft.get("sections") or []):
            units = [("draft:s" + str(si + 1), sec.get("heading") or "")]
            units += [("draft:" + str(si + 1) + "." + str(pi + 1), par.get("text") or "")
                      for pi, par in enumerate(sec.get("paragraphs") or [])]
            for ref, raw in units:
                checked += 1
                found = scan(prepare(raw), lambda _p, r=ref: r, False)
                found.sort(key=lambda f: (f[0], f[1]))
                problems += [f[2] for f in found]
        made = (named(gate_input, "search_record").get("produced_by") or {}).get("step_id")
        if made is not None and made == (draft_port.get("produced_by") or {}).get("step_id"):
            found = scan(record, at_line, True)
            found.sort(key=lambda f: (f[0], f[1]))
            problems += [f[2] for f in found]
        for pos, n in included_statements(record):
            checked += 1
            if n != len(items):
                counts["included_count_changed"] += 1
                warns.append({"ref": at_line(pos), "detail": "included_count_changed; search_record=" + str(n)
                              + "; register=" + str(len(items))})
    failed = sum(counts[k] for k in FAILS)
    status = "fail" if failed else ("warn" if counts["included_count_changed"] else "pass")
    summary = {"ref": "summary", "detail": " ".join(k + "=" + str(counts[k]) for k in ORDER)}
    return status, checked, failed, [summary] + problems + warns


run(GATE_ID, GATE_REF, check)
