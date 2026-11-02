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


GATE_ID = "cite_gate"
GATE_REF = "cite_gate@0.5.0"
ORDER = ["verified", "possible", "unverified_url", "lookup_error", "not_found", "doi_not_found",
         "doi_title_mismatch", "unresolved_citation", "unsupported_claim", "no_references",
         "reference_not_in_register", "duplicate_ref_id", "duplicate_register_id", "unparsed_marker"]
FAIL = {"unresolved_citation", "unsupported_claim", "no_references", "reference_not_in_register",
        "duplicate_ref_id", "duplicate_register_id", "doi_title_mismatch", "doi_not_found", "not_found"}
WARN = {"possible", "unverified_url", "lookup_error", "unparsed_marker"}
BRACKET = re.compile(r"\[([^\[\]]+)\]")
LEADING_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]*")
MARKER = re.compile(r"^([A-Za-z](?=[A-Za-z0-9_.:-]*[0-9])[A-Za-z0-9_.:-]*)(?:,\s*(?:p\.\s*[0-9]+|pp\.\s*[0-9]+[-–][0-9]+))?$")


def markers(text):
    """Source ids cited in a paragraph's text, in order of first appearance. A bracket whose first token is
    id-shaped (a letter, then letters, digits or `_.:-`, with a digit in it) is a marker bracket: each
    `;`-separated part that is `id`, `id, p. N` or `id, pp. N-M` (hyphen or en dash) gives its id; if any part
    does not parse the bracket counts once as unparsed and its leading id is still returned."""
    out = []
    unparsed = 0
    for m in BRACKET.finditer(text):
        lead = LEADING_ID.match(m.group(1).strip())
        if not lead or not any(c in "0123456789" for c in lead.group(0)):
            continue
        found = [MARKER.match(p.strip()) for p in m.group(1).split(";")]
        ids = [f.group(1) for f in found if f]
        if not all(found):
            unparsed += 1
            if not found[0]:
                ids.insert(0, lead.group(0))
        for sid in ids:
            if sid not in out:
                out.append(sid)
    return out, unparsed


def clean_doi(doi):
    d = doi.strip().lower()
    for prefix in ("https://doi.org/", "http://dx.doi.org/", "doi:"):
        if d.startswith(prefix):
            d = d[len(prefix):]
            break
    return d


def arxiv_records(body):
    """(title, doi, venue) for each entry of an arXiv API feed, in feed order; doi is the entry's arxiv:doi."""
    out = []
    for entry in re.findall(r"<entry>([\s\S]*?)</entry>", body):
        t = re.search(r"<title[^>]*>([\s\S]*?)</title>", entry)
        if not t:
            continue
        d = re.search(r"<arxiv:doi[^>]*>([\s\S]*?)</arxiv:doi>", entry)
        out.append((decode_entities(t.group(1)), d.group(1).strip() if d else "", "arXiv"))
    return out


def crossref_record(item):
    """(title, doi, venue) of a Crossref work: its first title, its DOI and its first container title."""
    titles = item.get("title") or []
    venues = item.get("container-title") or []
    return (titles[0] if titles else "", item.get("DOI") or "", venues[0] if venues else "")


def best_of(title, records):
    """The record whose title is most similar to title (the first of equals), and that similarity."""
    best, found = 0, ("", "", "")
    for r in records:
        s = similarity(title, r[0])
        if s > best or not found[0]:
            best, found = s, r
    return best, found


NONE = ("", "", "")
# Whitespace, spelled out so both runtimes collapse the same characters.
WS = re.compile("[ \\t\\n\\r\\f\\v\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")


def lookup(entry, refs):
    """Returns (outcome, sim, record) for one register item, record being the closest (title, doi, venue) found;
    refs are the references naming it."""
    title = entry.get("title") or ""
    locator = entry.get("locator") or {}
    doi = locator.get("doi") or next((r["doi"] for r in refs if r.get("doi")), None)
    url = locator.get("url") or next((r["url"] for r in refs if r.get("url")), None)
    if doi:
        status, body = fetch(GATE_ID, "https://api.crossref.org/works/" + pct(clean_doi(doi), "/"))
        if status == 200:
            found = crossref_record(json.loads(body).get("message") or {})
            if not found[1]:
                found = (found[0], clean_doi(doi), found[2])
            sim = similarity(title, found[0])
            return ("verified" if sim >= 90 else "doi_title_mismatch"), sim, found
        if status == 404:
            return "doi_not_found", 0, NONE
        return "lookup_error", 0, NONE
    arxiv_id = locator.get("arxiv_id")
    if arxiv_id:
        status, body = fetch(GATE_ID, "https://export.arxiv.org/api/query?id_list=" + pct(arxiv_id))
        if status != 200:
            return "lookup_error", 0, NONE
        sim, found = best_of(title, arxiv_records(body))
        return ("verified" if sim >= 90 else "not_found"), sim, found
    status, body = fetch(GATE_ID, "https://api.crossref.org/works?query.bibliographic=" + pct(title) + "&rows=5")
    if status != 200:
        return "lookup_error", 0, NONE
    items = (json.loads(body).get("message") or {}).get("items") or []
    sim, found = best_of(title, [crossref_record(i) for i in items if i.get("title")])
    if sim < 90:
        status, body = fetch(GATE_ID, "https://export.arxiv.org/api/query?search_query="
                             + pct('ti:"' + title + '"') + "&max_results=3")
        if status != 200:
            return "lookup_error", 0, NONE
        sim2, found2 = best_of(title, arxiv_records(body))
        if sim2 > sim:
            sim, found = sim2, found2
    if sim >= 90:
        return "verified", sim, found
    if sim >= 75:
        return "possible", sim, found
    if url:
        return "unverified_url", sim, found
    return "not_found", sim, found


def part(value, limit):
    """A value for the evidence detail: whitespace collapsed, ';' made ',' (it separates the parts), at most
    limit characters, '-' when empty."""
    v = WS.sub(" ", value).strip(" ").replace(";", ",")
    return v[:limit] or "-"


def check(gate_input, load):
    draft = load(gate_input["target"])
    register = load(gate_input["extra_inputs"][0])
    items = register.get("items") or []
    register_ids = {e["source_id"] for e in items}
    references = draft.get("references") or []
    ref_sources = {r["source_id"] for r in references}
    counts = {k: 0 for k in ORDER}
    evidence = []

    def flag(outcome, ref):
        counts[outcome] += 1
        evidence.append({"ref": ref, "detail": outcome})

    claims = []
    for si, section in enumerate(draft.get("sections") or [], 1):
        for pi, para in enumerate(section.get("paragraphs") or [], 1):
            ids, unparsed = markers(para.get("text") or "")
            for sid in ids:
                if sid not in ref_sources:
                    flag("unresolved_citation", "%d.%d:%s" % (si, pi, sid))
            for _ in range(unparsed):
                flag("unparsed_marker", "%d.%d" % (si, pi))
            claims.extend(para.get("claims") or [])
    for claim in claims:
        for sup in claim.get("support") or []:
            if sup["source_id"] not in ref_sources:
                flag("unresolved_citation", claim["claim_id"] + ":" + sup["source_id"])
    for claim in claims:
        if claim.get("kind") == "evidence" and not claim.get("support"):
            flag("unsupported_claim", claim["claim_id"])
    if claims and not references:
        flag("no_references", "draft")
    for ref in references:
        if ref["source_id"] not in register_ids:
            flag("reference_not_in_register", ref["ref_id"])
    seen = set()
    for ref in references:
        if ref["ref_id"] in seen:
            flag("duplicate_ref_id", ref["ref_id"])
        seen.add(ref["ref_id"])
    seen = set()
    for entry in items:
        if entry["source_id"] in seen:
            flag("duplicate_register_id", entry["source_id"])
        seen.add(entry["source_id"])
    for entry in items:
        refs = [r for r in references if r["source_id"] == entry["source_id"]]
        outcome, sim, found = lookup(entry, refs)
        counts[outcome] += 1
        if outcome != "verified":
            # The closest record's title as published (not folded), its DOI and its venue, so the person can judge a
            # near match (ask 109). At most 200 + 80 + 58 characters, so the detail stays within 400.
            evidence.append({"ref": entry["source_id"], "detail": "%s; sim=%d; found=%s; found_doi=%s; found_venue=%s"
                             % (outcome, sim, part(found[0], 200), part(found[1], 80), part(found[2], 58))})
    failed = sum(counts[k] for k in FAIL)
    status = "fail" if failed else ("warn" if any(counts[k] for k in WARN) else "pass")
    summary = {"ref": "summary", "detail": " ".join("%s=%d" % (k, counts[k]) for k in ORDER)}
    return status, len(items), failed, [summary] + evidence


run(GATE_ID, GATE_REF, check)
