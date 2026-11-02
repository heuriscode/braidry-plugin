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

GATE_ID = "quote_gate"
GATE_REF = "quote_gate@0.2.0"
ORDER = ["match", "not_in_abstract", "unverifiable", "no_match", "quote_on_record_read"]
FRAGMENT_SPLIT = re.compile(r"\[\.\.\.\]|\.\.\.|…")
MIN_FRAGMENT = 6


def clean_doi(value):
    if not isinstance(value, str):
        return None
    low = value.strip().lower()
    for prefix in ("https://doi.org/", "http://dx.doi.org/", "doi:"):
        if low.startswith(prefix):
            low = low[len(prefix):]
            break
    return low or None


def parse_json(body):
    try:
        value = json.loads(body)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def rebuild_abstract(index):
    if not isinstance(index, dict):
        return ""
    slots = {}
    for word, positions in index.items():
        for pos in positions:
            slots[pos] = word
    return " ".join(slots[p] for p in sorted(slots))


def lookup_text(doi, arxiv_id):
    """Source text (title plus abstract) or None. Crossref, then OpenAlex, then arXiv."""
    if doi:
        status, body = fetch(GATE_ID, "https://api.crossref.org/works/" + pct(doi, "/"))
        title, abstract = "", ""
        if status == 200:
            message = parse_json(body).get("message") or {}
            titles = message.get("title") or []
            title = titles[0] if titles and isinstance(titles[0], str) else ""
            abstract = message.get("abstract") or ""
        if not abstract.strip():
            status, body = fetch(GATE_ID, "https://api.openalex.org/works/doi:" + pct(doi, "/"))
            if status == 200:
                abstract = rebuild_abstract(parse_json(body).get("abstract_inverted_index"))
        if abstract.strip():
            return title + " " + abstract
    if arxiv_id:
        status, body = fetch(GATE_ID, "https://export.arxiv.org/api/query?id_list=" + pct(arxiv_id))
        if status == 200:
            m = re.search(r"<summary[^>]*>([\s\S]*?)</summary>", body)
            if m and m.group(1).strip():
                return m.group(1)
    return None


def has_checkable_fragment(quote):
    return any(len(norm_text(f)) >= MIN_FRAGMENT for f in FRAGMENT_SPLIT.split(quote))


def quote_matches(quote, text):
    haystack = norm_text(text)
    for fragment in FRAGMENT_SPLIT.split(quote):
        needle = norm_text(fragment)
        if len(needle) >= MIN_FRAGMENT and needle not in haystack:
            return False
    return True


def collect(contract, target, register_by_id):
    """List of (source_id, quote, read_level, doi, arxiv_id) in input order."""
    out = []

    def add(source_id, quote, level, doi):
        if isinstance(quote, str) and quote.strip():
            reg = register_by_id.get(source_id) or {}
            loc = reg.get("locator") or {}
            out.append((source_id, quote, level or reg.get("read_level") or "abstract",
                        clean_doi(doi or loc.get("doi")), loc.get("arxiv_id") or None))

    if contract == "evidence_table":
        for row in target.get("rows") or []:
            for finding in row.get("key_findings") or []:
                add(row.get("source_id"), (finding.get("anchor") or {}).get("quote"), row.get("read_level"), None)
    elif contract == "draft":
        refs = {r.get("source_id"): r for r in target.get("references") or []}
        for section in target.get("sections") or []:
            for para in section.get("paragraphs") or []:
                for claim in para.get("claims") or []:
                    for sup in claim.get("support") or []:
                        sid = sup.get("source_id")
                        ref = refs.get(sid) or {}
                        add(sid, (sup.get("anchor") or {}).get("quote"), ref.get("read_level"), ref.get("doi"))
    else:
        raise ValueError("quote_gate: unsupported target contract " + str(contract))
    return out


def check(gate_input, load):
    target_port = gate_input["target"]
    extra = gate_input.get("extra_inputs") or []
    register = load(extra[0]) if extra else {}
    register_by_id = {i.get("source_id"): i for i in register.get("items") or []}
    quotes = collect(target_port["contract"], load(target_port), register_by_id)
    counts = {k: 0 for k in ORDER}
    seen = {}
    texts = {}
    items = []
    for source_id, quote, level, doi, arxiv_id in quotes:
        seen[source_id] = seen.get(source_id, 0) + 1
        if level == "record":
            outcome = "quote_on_record_read"
        elif not has_checkable_fragment(quote):
            outcome = "unverifiable"
        else:
            if source_id not in texts:
                texts[source_id] = lookup_text(doi, arxiv_id)
            text = texts[source_id]
            if text is None:
                outcome = "unverifiable"
            elif quote_matches(quote, text):
                outcome = "match"
            elif level in ("full_text", "full_text_partial"):
                outcome = "not_in_abstract"
            else:
                outcome = "no_match"
        counts[outcome] += 1
        if outcome != "match":
            items.append({"ref": "%s#%d" % (source_id, seen[source_id]),
                          "detail": "%s; read_level=%s" % (outcome, level)})
    failed = counts["no_match"] + counts["quote_on_record_read"]
    if failed:
        status = "fail"
    elif counts["not_in_abstract"] or counts["unverifiable"]:
        status = "warn"
    else:
        status = "pass"
    summary = {"ref": "summary", "detail": " ".join("%s=%d" % (k, counts[k]) for k in ORDER)}
    return status, len(quotes), failed, [summary] + items


run(GATE_ID, GATE_REF, check)
