# --- gatekit 0.1.0 (Python) --- embedded verbatim in every Python gate; tests/braids/test_gatekit.py checks it.
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


GATE_ID = "revision_gate"
GATE_REF = "revision_gate@0.4.0"
ORDER = ["uncovered_change", "fingerprint_mismatch", "duplicate_id", "unchanged_range", "too_many_changes", "comparison_skipped"]
WARNS = ("unchanged_range", "comparison_skipped")
CHANGE_CAP = 50
PARA_POINTER = re.compile(r"^/sections/[0-9]+/paragraphs/[0-9]+$")
PAIRS = [("sources_before", "sources_after"), ("evidence_before", "evidence_after")]


def covers(location, pointer):
    if location in ("sources#", "evidence#"):
        return pointer.startswith(location)
    return pointer == location or pointer.startswith(location + "/")


def changes(before, after):
    """Pointers of changed paragraphs (after draft; before draft for removed ones) and changed headings."""
    out = []
    bs, af = before.get("sections") or [], after.get("sections") or []
    for i in range(max(len(bs), len(af))):
        b = bs[i] if i < len(bs) else None
        a = af[i] if i < len(af) else None
        if a is not None and b is not None and a.get("heading") != b.get("heading"):
            out.append("/sections/%d/heading" % i)
        bp = (b or {}).get("paragraphs") or []
        ap = (a or {}).get("paragraphs") or []
        for j in range(max(len(bp), len(ap))):
            pointer = "/sections/%d/paragraphs/%d" % (i, j)
            if j >= len(ap) or j >= len(bp):
                out.append(pointer)
            elif bp[j].get("text") != ap[j].get("text") or canonical(bp[j].get("claims") or []) != canonical(ap[j].get("claims") or []):
                out.append(pointer)
    return out


def differs(b, a, keys=None):
    if keys is not None:
        b = {k: (b or {}).get(k) for k in keys}
        a = {k: (a or {}).get(k) for k in keys}
    return canonical(b) != canonical(a)


def list_changes(prefix, id_key, before, after, keys=None):
    """Pointers of list entries matched by `id_key`; an added, removed or changed entry is changed. Entries
    present in the after list come first, in after order, then removed ones in before order."""
    old = {}
    for item in before:
        old.setdefault(item.get(id_key), item)
    new = {}
    for item in after:
        new.setdefault(item.get(id_key), item)
    out = []
    for key, item in new.items():
        if key not in old or differs(old[key], item, keys):
            out.append(prefix + str(key))
    for key in old:
        if key not in new:
            out.append(prefix + str(key))
    return out


def all_changes(drafts, sources, evidence):
    out = changes(drafts[0], drafts[1])
    out += list_changes("/references/", "ref_id", drafts[0].get("references") or [], drafts[1].get("references") or [])
    if sources:
        out += list_changes("sources#", "source_id", sources[0].get("items") or [], sources[1].get("items") or [],
                            ("read_level", "title", "locator"))
    if evidence:
        out += list_changes("evidence#", "source_id", evidence[0].get("rows") or [], evidence[1].get("rows") or [],
                            ("read_level", "key_findings", "evidence_strength"))
    return out


def raw_fp(port):
    with open(port["path"], "rb") as fh:
        return fp_raw(fh.read())


def load_pair(extra, load, at):
    """(before, after) documents for the extra inputs at `at` and `at + 1`, or None when not supplied."""
    if len(extra) <= at + 1:
        return None
    return load(extra[at]), load(extra[at + 1])


def check(gate_input, load):
    log = load(gate_input["target"])
    extra = gate_input["extra_inputs"]
    before_port, after_port = extra[0], extra[1]
    before, after = load(before_port), load(after_port)
    ranges = [r["location"] for r in log.get("added_ranges") or []]
    counts = {k: 0 for k in ORDER}
    failures = []
    warnings = []

    def flag(outcome, ref):
        counts[outcome] += 1
        (warnings if outcome in WARNS else failures).append({"ref": ref, "detail": outcome})

    def duplicates(port, items, id_key):
        seen = set()
        for item in items:
            key = item.get(id_key)
            if key in seen:
                flag("duplicate_id", "%s#%s" % (port, key))
            seen.add(key)

    pairs = []
    for n, names in enumerate(PAIRS):
        at = 2 + 2 * n
        pairs.append(load_pair(extra, load, at))
        if len(extra) <= at + 1:
            flag("comparison_skipped", extra[at]["port"] if len(extra) > at else names[0])
    for port, doc in ((before_port, before), (after_port, after)):
        duplicates(port["port"], doc.get("references") or [], "ref_id")
    for at, key in ((0, "items"), (1, "rows")):
        if pairs[at]:
            for k in (0, 1):
                duplicates(extra[2 + 2 * at + k]["port"], pairs[at][k].get(key) or [], "source_id")
    changed = all_changes((before, after), pairs[0], pairs[1])
    for pointer in changed:
        if not any(covers(loc, pointer) for loc in ranges):
            flag("uncovered_change", pointer)
    if log.get("from_fingerprint") != raw_fp(before_port):
        flag("fingerprint_mismatch", "/from_fingerprint")
    if log.get("to_fingerprint") != raw_fp(after_port):
        flag("fingerprint_mismatch", "/to_fingerprint")
    for loc in ranges:
        if PARA_POINTER.match(loc) and loc not in changed:
            flag("unchanged_range", loc)
    if 1 + len(failures) + len(changed) > CHANGE_CAP:
        flag("too_many_changes", "/changes")
    evidence = failures + [{"ref": pointer, "detail": "changed"} for pointer in changed] + warnings
    paragraphs = sum(len(s.get("paragraphs") or []) for s in after.get("sections") or [])
    failed = counts["uncovered_change"] + counts["fingerprint_mismatch"] + counts["duplicate_id"] + counts["too_many_changes"]
    warned = counts["unchanged_range"] + counts["comparison_skipped"]
    status = "fail" if failed else ("warn" if warned else "pass")
    summary = {"ref": "summary", "detail": " ".join("%s=%d" % (k, counts[k]) for k in ORDER)}
    return status, paragraphs, failed, [summary] + evidence


run(GATE_ID, GATE_REF, check)
