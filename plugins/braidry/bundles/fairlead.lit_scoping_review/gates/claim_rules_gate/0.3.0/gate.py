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


GATE_ID = "claim_rules_gate"
GATE_REF = "claim_rules_gate@0.3.0"
ORDER = ["record_only_support", "absence_on_abstract", "unscoped_none"]
ABSENCE = ["does not", "do not", "did not", "no evidence", "not report", "not compare", "not examine",
           "not address", "fails to", "omits"]
SCARCITY = ["no study", "no studies", "none of the", "few studies", "little evidence", "thin", "rarely", "scarce",
            "no research"]
SCOPE = ["screened", "searched", "read in full", "included in this review"]
BRACKET = re.compile(r"[ \t]*\[([^\[\]]+)\]")
MARKER = re.compile(r"^[A-Za-z](?=[A-Za-z0-9_.:-]*[0-9])[A-Za-z0-9_.:-]*"
                    r"(?:,\s*(?:p\.\s*[0-9]+|pp\.\s*[0-9]+-[0-9]+))?$")
POOL_NUMBER = re.compile(r"(?:^|[^0-9a-z,.])(?:[0-9][0-9,]* (?:works|studies|sources|papers|records|articles)"
                         r"|of the (?!(?:19|20)[0-9]{2}(?![0-9]|,[0-9]))[0-9][0-9,]*)(?:$|[^0-9a-z])")


def first_phrase(folded, phrases):
    padded = " " + folded + " "
    for p in phrases:
        if " " + p + " " in padded:
            return p
    return None


def strip_markers(text):
    """Removes citation markers (every `;`-separated part is `id`, `id, p. N` or `id, pp. N-M`) and the
    whitespace before them, so a marker's digits never count as a number."""
    def repl(m):
        parts = [x.strip() for x in m.group(1).split(";")]
        return "" if all(MARKER.match(x) for x in parts) else m.group(0)
    return BRACKET.sub(repl, text)


def unscoped_phrase(text):
    """First scarcity phrase in a sentence with no pool scope: a number next to a pool noun (`54 works`,
    `of the 54`) or one of the SCOPE phrases."""
    for sentence in re.split(r"[.!?]+(?:[ \t\r\n]+|$)", strip_markers(text)):
        folded = ascii_fold(sentence)
        phrase = first_phrase(folded, SCARCITY)
        if phrase is None:
            continue
        if POOL_NUMBER.search(" " + folded + " ") or first_phrase(folded, SCOPE):
            continue
        return phrase
    return None


def check(gate_input, load):
    draft = load(gate_input["target"])
    register = load(gate_input["extra_inputs"][0])
    levels = {e["source_id"]: e.get("read_level") for e in register.get("items") or []}
    for r in draft.get("references") or []:
        levels[r["source_id"]] = r.get("read_level")
    counts = {k: 0 for k in ORDER}
    evidence = []
    checked = 0

    def flag(outcome, ref, phrase=None):
        counts[outcome] += 1
        evidence.append({"ref": ref, "detail": outcome + ("; phrase=" + phrase if phrase else "")})

    for si, section in enumerate(draft.get("sections") or [], 1):
        for pi, para in enumerate(section.get("paragraphs") or [], 1):
            checked += 1
            phrase = unscoped_phrase(para.get("text") or "")
            if phrase:
                flag("unscoped_none", "%d.%d" % (si, pi), phrase)
            for claim in para.get("claims") or []:
                checked += 1
                cid = claim["claim_id"]
                support = claim.get("support") or []
                sup_levels = [levels.get(s["source_id"]) for s in support]
                if claim.get("kind") == "evidence" and support and all(v == "record" for v in sup_levels):
                    flag("record_only_support", cid)
                if support and all(v in ("abstract", "record") for v in sup_levels):
                    phrase = first_phrase(ascii_fold(claim.get("text") or ""), ABSENCE)
                    if phrase:
                        flag("absence_on_abstract", cid, phrase)
                phrase = unscoped_phrase(claim.get("text") or "")
                if phrase:
                    flag("unscoped_none", cid, phrase)
    failed = counts["record_only_support"]
    status = "fail" if failed else ("warn" if any(counts.values()) else "pass")
    summary = {"ref": "summary", "detail": " ".join("%s=%d" % (k, counts[k]) for k in ORDER)}
    return status, checked, failed, [summary] + evidence


run(GATE_ID, GATE_REF, check)
