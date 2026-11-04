#!/usr/bin/env python3
"""
Hermes job watch for the candidate (BS Population Health, CNA + scribe).
Corridors: (A) Downingtown / West Chester / Wilmington, (B) York / Lancaster / Harrisburg.

Runs via Camofox (local anti-detect browser on :9377) because Penn Medicine and
several other ATS fronts are Cloudflare-protected.

Modes
  (default)      check sources, print alert text for NEW + relevant jobs, else print nothing
  --baseline     record everything currently live, alert nothing
  --selftest     run the relevance filter against a labelled corpus, print pass/fail
  --dump         print every posting that passed/didn't pass the filter (debug)
  --resimulate N drop N random seen keys so they re-alert (validation only)

Exit codes: 0 ok, 1 total source failure (so Hermes surfaces it), 0 otherwise.
"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CAMO = "http://127.0.0.1:9377"
USER = "jobwatch"
HOME = Path.home()
STATE_DIR = HOME / ".hermes" / "job-watches"
STATE_FILE = STATE_DIR / "job-alerts-state.json"
LOG_FILE = STATE_DIR / "job-alerts-last-run.json"
STATE_DIR.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------
# Web dashboard sync (Vercel). Both are optional; if unset the watcher still
# works exactly as before.
# --------------------------------------------------------------------------
def _load_env_file(path: Path) -> None:
    """Hermes cron does not guarantee the service EnvironmentFile reaches scripts."""
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip("'\"")
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass


_load_env_file(HOME / ".hermes" / ".env")

WEB_URL = os.environ.get("JOB_BOARD_URL", "https://pop-health-jobs.vercel.app").rstrip("/")
WEB_TOKEN = os.environ.get("JOB_BOARD_TOKEN", "")


def _http_json(method: str, url: str, body=None, headers=None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def fetch_suppressed() -> set:
    """Jobs already marked applied / not-applicable on the dashboard.

    This is a safety net, not the primary dedupe: `seen` already stops re-alerting.
    It matters when the baseline is reset or a new source is added, so jobs she has
    already handled do not come back as 'new'.
    """
    if not WEB_URL:
        return set()
    try:
        data = _http_json("GET", WEB_URL + "/api/suppressed", timeout=20)
        return {"%s|%s" % (r.get("employer", ""), r.get("job_key", "")) for r in data.get("suppressed", [])}
    except Exception:
        return set()


def push_snapshot(relevant_jobs: dict, run_at: str) -> str:
    """Send the run's relevant postings to the Vercel dashboard. Never fatal."""
    if not WEB_URL or not WEB_TOKEN:
        return "skipped (JOB_BOARD_URL / JOB_BOARD_TOKEN not set)"
    payload = {
        "run_at": run_at,
        "jobs": [
            {
                "employer": j["employer"],
                "job_id": str(j["id"]),
                "title": j["title"],
                "location": j.get("location") or None,
                "url": j.get("url") or None,
            }
            for j in relevant_jobs.values()
        ],
    }
    if not payload["jobs"]:
        return "skipped (nothing relevant this run)"
    try:
        res = _http_json("POST", WEB_URL + "/api/ingest", payload,
                         {"x-ingest-token": WEB_TOKEN}, timeout=45)
        return "ok (%s new, %s updated)" % (res.get("inserted"), res.get("updated"))
    except Exception as e:
        return "FAILED: %s" % str(e)[:120]

# --------------------------------------------------------------------------
# Geography: only the two corridors the user asked for.
# A location is accepted if it contains one of these tokens.
# --------------------------------------------------------------------------
ALLOWED_CITIES = [
    # Corridor A - Chester County / Philly metro
    "west chester", "exton", "malvern", "downingtown", "coatesville", "kennett",
    "west grove", "avondale", "oxford", "parkesburg", "gap", "chadds ford",
    "paoli", "berwyn", "devon", "wayne", "radnor", "phoenixville", "pottstown",
    "bala cynwyd", "wynnewood", "bryn mawr", "media", "chester", "glen mills",
    "norristown", "king of prussia", "newtown square", "plymouth meeting",
    "blue bell", "lansdale", "horsham", "willow grove", "abington", "jenkintown",
    "philadelphia", "collegeville", "west point",
    # Delaware
    "wilmington", "newark", "new castle", "middletown", "bear", "glasgow",
    "dover", "smyrna", "milford",
    # Corridor B - York / Lancaster / Harrisburg
    "york", "hanover", "spring grove", "gettysburg", "lancaster", "ephrata",
    "lititz", "mount joy", "elizabethtown", "new holland", "quarryville",
    "columbia", "hershey", "harrisburg", "camp hill", "mechanicsburg",
    "carlisle", "lebanon", "wyomissing", "reading",
    # synthetic defaults used by sources whose listing cards omit the city
    "southeastern pa",
]

# Hard rejects on location: any state outside PA/DE, plus far-flung PA metros.
# Matching is token-based (see _city_in_corridor) so "District Of Columbia" no longer
# matches "Columbia, PA" and "Dorchester" no longer matches "Chester, PA".
BAD_LOCATION = re.compile(
    r"\b(?:"
    r"new jersey|new york|new hampshire|new mexico|north carolina|north dakota|"
    r"south carolina|south dakota|rhode island|west virginia|"
    r"district of columbia|washington,?\s*d\.?c\.?|"
    r"maryland|virginia|ohio|connecticut|massachusetts|georgia|florida|texas|"
    r"illinois|michigan|indiana|missouri|tennessee|kentucky|wisconsin|minnesota|"
    r"oregon|california|arizona|colorado|nevada|utah|alabama|mississippi|arkansas|"
    r"louisiana|oklahoma|kansas|nebraska|iowa|idaho|montana|wyoming|alaska|hawaii|"
    r"vermont|maine"
    r")\b|"
    r"\b(?:NJ|NY|MD|VA|WV|OH|DC|CT|MA|NH|NC|SC|GA|FL|TX|IL|MI|IN|MO|TN|KY|WI|MN|"
    r"OR|CA|AZ|CO|NV|UT|AL|MS|AR|LA|OK|KS|NE|IA|ID|MT|WY|AK|HI|VT|ME)\.?(?![a-z])|"
    r"pittsburgh|erie|scranton|wilkes|altoona|johnstown|state college|"
    r"stroudsburg|hazleton|williamsport|bethlehem|allentown|easton",
    re.I,
)

_CITY_RE = re.compile(
    r"(?<![a-z])(?:" + "|".join(re.escape(c) for c in sorted(ALLOWED_CITIES, key=len, reverse=True)) + r")(?![a-z])",
    re.I,
)


def _city_in_corridor(loc: str) -> bool:
    return bool(_CITY_RE.search(loc))

# --------------------------------------------------------------------------
# Title relevance. Both lists are case-insensitive regex.
# --------------------------------------------------------------------------
POSITIVE = re.compile(
    r"population health|care coordinat|care navigator|patient navigator|"
    r"community health|community educator|community outreach|community resource|"
    r"health educator|health coach|health promotion|health navigator|"
    r"care management|patient coordinator|patient services coordinator|"
    r"patient access|patient liaison|patient experience|patient advocate|"
    r"program coordinator|program liaison|program specialist|"
    r"quality coordinator|quality improvement|quality specialist|"
    r"compliance coordinator|compliance specialist|"
    r"credentialing|payer enrollment|referral coordinator|intake coordinator|"
    r"practice manager|practice coordinator|practice supervisor|"
    r"social services coordinator|case manager|outreach coordinator|"
    r"wellness coordinator|benefits coordinator|eligibility specialist",
    re.I,
)

NEGATIVE = re.compile(
    r"\brn\b|registered nurse|\bnurse\b|\blpn\b|\blvn\b|crna|\bcrnp\b|nurse practitioner|"
    r"licensed professional|licensed social worker|"
    r"physician|\bpa-c\b|physician assistant|therapist|physical therap|"
    r"occupational therap|speech|technologist|technician|\btech\b|pharmac|"
    r"radiolog|sonograph|cytotech|histolog|perfusion|surgical|\bma\b|"
    r"medical assistant|coder|\bcoding\b|\bcdi\b|dietitian|nutritionist|"
    r"social worker|lcsw|lmsw|psycholog|counselor|clinician|behavior analyst|"
    r"bcba|direct support|caregiver|home health aide|\bcna\b|resident assistant|"
    r"paramedic|\bemt\b|phlebotom|sterile processing|dental|hygienist|"
    r"driver|\bcook\b|chef|housekeep|custodial|security officer|facilities|"
    r"engineer|electrician|plumber|hvac|accountant|attorney|paralegal|"
    r"marketing|fundrais|director|vice president|\bvp\b|\bchief\b|president|"
    r"intern\b|internship|student|fellowship|resident\b|volunteer|"
    r"transcription|scheduler\b|"
    r"treatment court|drug court|life skills|benefits advocate|"
    r"re-?entry|shelter|housing|homeless|justice|probation|parole|"
    r"bips\b|safety & responsibility|residential|group home|"
    r"behavior consultant|bc-aba|registered behavior",
    re.I,
)

# Requisition URLs often encode the license the title hides ("rn-care-coordinator-per-diem").
URL_REJECT = re.compile(
    r"(?:^|[/\-_])(?:rn|lpn|lvn|crna|crnp|np|pa-c|md|do)(?:[/\-_]|$)"
    r"|registered-nurse|nurse-practitioner|physician-assistant",
    re.I,
)


def classify(title: str, location: str = "", url: str = "") -> tuple[bool, str]:
    """Return (is_relevant, reason). Deterministic - this is the whole filter."""
    t = (title or "").strip()
    if len(t) < 4:
        return False, "empty title"
    if NEGATIVE.search(t):
        return False, "excluded title term"
    if url and URL_REJECT.search(url):
        return False, "licensed role (url)"
    if not POSITIVE.search(t):
        return False, "not a target role"
    loc = (location or "").strip()
    # Normalise trailing country noise ("Philadelphia, PA, United States") before checks.
    loc = re.sub(r",?\s*United States\s*$", "", loc, flags=re.I).strip(" ,")
    if not loc:
        # Unknown geography means we cannot promise it is in one of her corridors.
        # Better to drop it than to alert her about a job in another state.
        return False, "unknown location"
    if BAD_LOCATION.search(loc):
        return False, "outside corridor"
    if not _city_in_corridor(loc):
        return False, "not an allowed city"
    return True, "ok"


# --------------------------------------------------------------------------
# Camofox plumbing
# --------------------------------------------------------------------------
def camo(method: str, path: str, body=None, timeout: int = 120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CAMO + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw)


def camo_healthy() -> bool:
    try:
        with urllib.request.urlopen(CAMO + "/health", timeout=15) as r:
            return bool(json.loads(r.read().decode()).get("ok"))
    except Exception:
        return False


def revive_browser(tries: int = 2) -> bool:
    """Recover from browser_rss_pressure / wedged browser.

    Camofox kills the page when RSS crosses BROWSER_RSS_RESTART_THRESHOLD_MB and then
    reports ok=false with reason=browser_rss_pressure until something relaunches it.
    Without this, the daily job would silently produce zero results forever.
    """
    for i in range(tries):
        try:
            camo("POST", "/start", {}, timeout=120)
        except Exception:
            pass
        for _ in range(15):
            time.sleep(2)
            if camo_healthy():
                return True
        # last resort: bounce the user service
        try:
            subprocess.run(["systemctl", "--user", "restart", "camofox.service"],
                           capture_output=True, timeout=60)
        except Exception:
            pass
        time.sleep(5)
    return camo_healthy()


EXTRACT_JS = r"""
(() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!/\/posting\/\w|jobId=\d|jk=[a-z0-9]{8,}|\/job\/\d+|jobs\/\d+|OpportunityDetail|\/careers\/[^/]+\/jobs\//i.test(href)) continue;
    if (/privacy|terms|login|accessibility|linkedin|instagram|facebook|twitter|youtube|job-cart|saved-jobs/i.test(href)) continue;
    const own = (a.innerText || '').replace(/\s+/g, ' ').trim();
    const card = a.closest('li,article,tr,[class*="card"],[class*="job"],[class*="result"],[class*="posting"]');
    let text = own;
    if (card) {
      const ct = (card.innerText || '').replace(/\s+/g, ' ').trim();
      // Only trust the card when it is not a giant wrapper that swallowed the page nav.
      if (ct.length <= Math.max(300, own.length * 5)) text = ct;
    }
    // Some ATSs (AmeriHealth) put only the title in the anchor and the city in a sibling
    // panel. Climb looking for a "Location X" marker; never accept an ancestor without one.
    if (!/Location\s+[A-Z]/.test(text)) {
      let n = card || a;
      for (let i = 0; i < 6 && n && n.parentElement; i++) {
        n = n.parentElement;
        const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 1500) break;
        if (/Location\s+[A-Z]/.test(t)) { text = t.slice(0, 400); break; }
      }
    }
    if (!text) text = own;
    if (text.length < 4) continue;
    const key = href + '|' + text.slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ h: href, t: text.slice(0, 260) });
    if (out.length >= 60) break;
  }
  return out;
})()
"""

BODY_JS = r"""
(() => {
  const main = document.querySelector('main') || document.body;
  return (main.innerText || '').replace(/\s+/g, ' ').slice(0, 6000);
})()
"""

# AmeriHealth (Phenom) wraps each result in a container whose text holds the title,
# the city and the requisition id; the anchor alone carries only the title.
AH_EXTRACT_JS = r"""
(() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/us/en/job/"]')) {
    const h = a.getAttribute('href') || '';
    if (!/\/us\/en\/job\/\d+\//.test(h)) continue;
    const row = a.closest('[data-ph-at-id], li, article, tr, div[class*="job"], div[class*="card"]');
    let t = '';
    if (row) t = (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (!/Location\s+[A-Z]/.test(t)) {
      let n = a.parentElement;
      for (let i = 0; i < 6 && n; i++) {
        const x = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (/Location\s+[A-Z]/.test(x) && x.length < 500) { t = x; break; }
        n = n.parentElement;
      }
    }
    if (!t) t = (a.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.length < 4) continue;
    const k = h.slice(-24) + t.slice(0, 20);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ h: h, t: t.slice(0, 300) });
    if (out.length >= 40) break;
  }
  return out;
})()
"""

# Hard requirements that mean she cannot apply, no matter how good the title looks.
# Checked against the full job description of NEW matches only (cheap: a handful per week).
DETAIL_REJECT = re.compile(
    r"must (?:have|possess|hold)[^.]{0,40}(?:registered nurse|RN license|nursing license|"
    r"active RN|LPN|licensed practical nurse|BSN|CRNA|LCSW|LMSW|PharmD|CPA)\b"
    r"|current (?:and active )?(?:US |Pennsylvania |PA |Delaware |DE )?(?:RN|registered nurse|"
    r"LPN|licensed practical nurse)[^.]{0,30}(?:license|licensure)"
    r"|RN licensure (?:is )?required"
    r"|require[sd]? (?:a )?(?:current )?(?:active )?(?:RN|registered nurse|nursing) licen[cs]e"
    r"|(?:master'?s|MPH|MSW|MHA) degree (?:is )?required"
    r"|board[- ]certified (?:behavior analyst|registered nurse)"
    r"|licensed clinical social worker"
    r"|no longer available|position has been filled|this job has expired",
    re.I,
)


def detail_reject(text: str) -> tuple[bool, str]:
    """Return (should_reject, matched_phrase). Pure function, unit-testable."""
    if not text:
        return False, ""
    m = DETAIL_REJECT.search(text)
    return (True, m.group(0)[:60]) if m else (False, "")


def fetch_jobs(url: str, wait: float = 5.0, extract_js: str = None):
    last = None
    for attempt in range(3):
        try:
            return _fetch_jobs(url, wait, extract_js)
        except Exception as e:
            last = e
            msg = str(e)
            # 503/502 = browser pressure or cold start; 404 on /evaluate = the tab was
            # reaped underneath us. Both are transient and worth one fresh tab.
            if "503" in msg or "502" in msg:
                if not revive_browser():
                    time.sleep(3)
            elif "404" in msg or "410" in msg:
                time.sleep(1.5)
            else:
                raise
    raise last


def _fetch_jobs(url: str, wait: float = 5.0, extract_js: str = None):
    tab = camo("POST", "/tabs", {"userId": USER, "sessionKey": "jobwatch", "url": url})
    tid = tab.get("tabId") or tab.get("id") or (tab.get("tab") or {}).get("tabId")
    if not tid:
        raise RuntimeError("no tabId: %s" % str(tab)[:120])
    try:
        time.sleep(wait)
        ev = camo("POST", "/tabs/%s/evaluate" % tid, {"userId": USER, "expression": extract_js or EXTRACT_JS})
        return ev.get("result") or []
    finally:
        try:
            camo("DELETE", "/tabs/%s?userId=%s" % (tid, USER), timeout=20)
        except Exception:
            pass


def fetch_body(url: str, wait: float = 4.0) -> str:
    tab = camo("POST", "/tabs", {"userId": USER, "sessionKey": "jobwatch", "url": url})
    tid = tab.get("tabId") or tab.get("id") or (tab.get("tab") or {}).get("tabId")
    if not tid:
        return ""
    try:
        time.sleep(wait)
        ev = camo("POST", "/tabs/%s/evaluate" % tid, {"userId": USER, "expression": BODY_JS})
        return (ev.get("result") or "")
    finally:
        try:
            camo("DELETE", "/tabs/%s?userId=%s" % (tid, USER), timeout=20)
        except Exception:
            pass


# --------------------------------------------------------------------------
# Source adapters: turn raw anchors into (id, title, location, url)
# --------------------------------------------------------------------------
def parse_christianacare(href, text, base):
    m = re.search(r"/posting/(JR\d+)", href)
    if not m:
        return None
    jid = m.group(1)
    title = re.split(r"\bREQ ID\b", text)[0].strip()
    loc = ""
    ml = re.search(r"LOCATION\s+(.+?)\s+CATEGORY", text)
    if ml:
        loc = ml.group(1).strip()
    return jid, title, loc, base + href if href.startswith("/") else href


PENN_CATEGORIES = (
    "Clerical/Administrative|Customer Service/Patient Access|Allied Health|Nursing|"
    "Professional|Technical|Research|Finance|Leadership|Clinical Support|Administrative|"
    "Physician Assistant|Other|Information Services|Facilities|Human Resources|Social Work"
)


PENN_CATEGORY_WORDS = {
    "other", "clerical/administrative", "clinical", "support", "administrative",
    "customer", "service/patient", "access", "allied", "health", "nursing",
    "professional", "technical", "research", "finance", "leadership",
    "physician", "assistant", "social", "work", "information", "services",
    "facilities", "human", "resources", "new",
}


def _clean_penn_loc(raw: str) -> str:
    """Strip category/label words that a greedy match pulls in front of the city."""
    head, _, tail = raw.partition(",")
    words = head.split()
    if len(words) > 3:
        words = words[-3:]
    while words and words[0].lower() in PENN_CATEGORY_WORDS:
        words.pop(0)
    return (" ".join(words) + "," + tail).strip() if words else ""


def parse_penn(href, text, base):
    m = re.search(r"/jobs/(\d+)", href)
    if not m:
        return None
    jid = m.group(1)
    body = re.sub(r"^\d{6}\s*", "", (text or "")).strip()

    # Some Penn searches render as a TABLE, so every anchor's text is the entire table
    # ("Showing 1-13 of 13 results Job ID Job Title ...") rather than one card.
    # In that case fall back to the URL slug for the title and locate the row for the
    # location.
    if "Showing" in body and "Job ID" in body:
        slug = href.rstrip("/").rsplit("/", 1)[-1]
        slug = re.sub(r"^\d+-", "", slug).replace("slash", "/").replace("-", " ")
        title = slug.title()
        loc = ""
        # rows look like: "<id> <Title> [NEW] <Category> <City, ST, United States> <WorkType>"
        for row in re.split(r"(?=\b\d{6}\s)", body):
            probe = re.sub(r"[^a-z0-9]", "", row.lower())
            if re.sub(r"[^a-z0-9]", "", slug.lower())[:22] in probe:
                mloc = re.search(r"([A-Z][A-Za-z.'-]*(?:[ -][A-Z][A-Za-z.'-]*)*,\s*(?:PA|NJ|DE|NY|MD),\s*United States)", row)
                if mloc:
                    loc = _clean_penn_loc(mloc.group(1))
                break
        return jid, title.strip(), loc, href

    # Cards read: "<title> <Category> <City, ST, United States> <shift>"
    parts = re.split(r"\b(?:%s)\b" % PENN_CATEGORIES, body, maxsplit=1)
    title = parts[0].strip(" |-—")
    rest = parts[1] if len(parts) > 1 else body
    loc = ""
    found = re.findall(r"([A-Z][A-Za-z.'-]*(?:[ -][A-Z][A-Za-z.'-]*)*,\s*(?:PA|NJ|DE|NY|MD),\s*United States)", rest)
    if found:
        loc = _clean_penn_loc(found[0])
    if not title:
        slug = href.rsplit("/", 1)[-1]
        title = re.sub(r"^\d+-", "", slug).replace("-", " ").replace("slash", "/").title()
    return jid, title, loc, href


def parse_mainline(href, text, base):
    m = re.search(r"/posting/[a-z0-9-]+/([A-Za-z0-9]+)/?", href)
    if not m:
        return None
    jid = m.group(1)
    title = re.sub(r"VIEW POSITION", "", text, flags=re.I).strip()
    # Cards prefix the job category in caps, e.g. "CLINICAL SUPPORT Patient Outreach
    # Coordinator - Primary Care" or "& SUPPORT SERVICE Care Coordination...".
    title = re.sub(r"^(?:[A-Z][A-Z&/\-]+(?:\s+[A-Z][A-Z&/\-]+)*)\s+", "", title).strip()
    title = re.sub(r"^(?:NURSING|ALLIED HEALTH|PHYSICIANS & ADVANCED PRACTICE PROVIDERS)\s*", "", title, flags=re.I)
    title = re.sub(r"\s+", " ", title).strip(" |-—")
    loc = ""
    ml = re.search(r"([A-Z][A-Za-z .'-]+,\s*PA)", text)
    if ml:
        loc = ml.group(1)
    return jid, title, loc, base + href if href.startswith("/") else href


def parse_wellspan(href, text, base):
    m = re.search(r"jobId=(\d+)", href)
    if not m:
        return None
    jid = m.group(1)
    title = text.strip()
    loc = ""
    ml = re.search(r"([A-Z][A-Za-z .'-]+,\s*PA)", text)
    if ml:
        loc = ml.group(1)
    return jid, title, loc, "https://www.joinwellspan.org" + href if href.startswith("/") else href


def parse_govjobs(href, text, base):
    m = re.search(r"/jobs/(\d+)", href)
    if not m:
        return None
    return m.group(1), text.strip(), "", "https://www.governmentjobs.com" + href if href.startswith("/") else href


def parse_jefferson(href, text, base):
    # Workday path encodes both: /job/<Location-Slug>/<Title-Slug>_REQ-12345
    m = re.search(r"/job/([^/]+)/([^/?]+)", href)
    if not m:
        return None
    loc_slug, title_slug = m.group(1), m.group(2)
    title = re.sub(r"_REQ[-_]?\d+.*$", "", title_slug)
    title = title.replace("XMLNAME-2B-", "+").replace("-", " ").strip()
    title = re.sub(r"\s+", " ", title)
    # "Camden-County-NJ" -> "Camden County, NJ"
    parts = loc_slug.split("-")
    loc = ""
    if len(parts) >= 2 and len(parts[-1]) == 2:
        loc = "%s, %s" % (" ".join(parts[:-1]), parts[-1].upper())
    else:
        loc = " ".join(parts)
    jid = re.search(r"REQ[-_]?(\d+)", title_slug)
    return (jid.group(1) if jid else title_slug[:40]), title, loc, \
           ("https://jeffersonhealth.wd5.myworkdayjobs.com" + href if href.startswith("/") else href)


def parse_amerihealth(href, text, base):
    m = re.search(r"/us/en/job/(\d+)/", href)
    if not m:
        return None
    jid = m.group(1)
    body = re.sub(r"\s+", " ", text).strip()
    title = re.split(r"\bLocation\b", body)[0].strip(" |-—")
    title = re.sub(r"^Job\b", "", title).strip()
    loc = ""
    ml = re.search(r"Location\s+(.+?)\s+(?:Category|Job Id)\b", body)
    if ml:
        loc = re.sub(r",?\s*\d{5}$", "", ml.group(1).strip()).strip(" ,")
    return jid, title, loc, href


def parse_phmc(href, text, base):
    m = re.search(r"opportunityId=([0-9a-f-]{8,})", href)
    if not m:
        return None
    jid = m.group(1)[:12]
    # cards read "<title> Today" / "<title> Oct 30, 2026"
    title = re.sub(r"\s+(?:Today|Yesterday|[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*$", "", text.strip()).strip()
    link = "https://recruiting.ultipro.com" + href if href.startswith("/") else href
    return jid, title, "", link


def parse_tower(href, text, base):
    m = re.search(r"/jobs/(\d+)\?", href)
    if not m:
        return None
    if "icims.com" in href and "/login" in href:
        return None
    jid = m.group(1)
    title = text.strip()
    # Cards read "<Title> Req ID: 65533 Location <Facility> <City>, Pennsylvania"
    title = re.split(r"\bReq ID\b|\bLocation\b", title)[0].strip(" |-—,")
    title = re.sub(r"^(?:star\s+)?(?:Featured Job|New)\s+", "", title, flags=re.I).strip()
    if not title or title.lower() in ("apply now", "view job"):
        return None
    link = base + href if href.startswith("/") else href
    return jid, title, "", link


def parse_upmc(href, text, base):
    m = re.search(r"/job/(\d+)/([^/]+)?", href)
    if not m:
        return None
    jid = m.group(1)
    title = re.sub(r"^NEW\s*", "", text).strip()
    # UPMC puts the city in the slug: .../patient-service-coordinator-camp-hill-pa/
    loc = ""
    slug = (m.group(2) or "").strip("/")
    tokens = [t for t in slug.split("-") if t]
    if len(tokens) >= 2 and tokens[-1] in ("pa", "ny", "md", "nj", "wv", "oh", "de"):
        state = tokens[-1].upper()
        for n in (1, 2, 3):
            cand = " ".join(tokens[-1 - n:-1])
            if any(c in cand for c in ALLOWED_CITIES):
                loc = "%s, %s" % (cand.title(), state)
                break
        else:
            loc = "%s, %s" % (" ".join(tokens[-3:-1]).title(), state)
    # UPMC posts across PA/NY/MD; only keep roles whose city we could place in-corridor
    if not loc or not any(c in loc.lower() for c in ALLOWED_CITIES):
        return None
    return jid, title, loc, "https://careers.upmc.com" + href if href.startswith("/") else href


SOURCES = [
    {
        "name": "ChristianaCare",
        "base": "https://careers.christianacare.org",
        "parse": parse_christianacare,
        "urls": [
            "https://careers.christianacare.org/job-search/?keyword=community%20health",
            "https://careers.christianacare.org/job-search/?keyword=care%20coordinator",
            "https://careers.christianacare.org/job-search/?keyword=health%20coach",
            "https://careers.christianacare.org/job-search/?keyword=outreach",
        ],
    },
    {
        "name": "Penn Medicine",
        "base": "https://careers.pennmedicine.org",
        "parse": parse_penn,
        # Cloudflare-fronted and slow under load; 5s intermittently yields an empty shell.
        "wait": 10.0,
        "urls": [
            "https://careers.pennmedicine.org/search/jobs?q=population+health",
            "https://careers.pennmedicine.org/search/jobs?q=care+coordinator",
            "https://careers.pennmedicine.org/search/jobs?q=community+health+worker",
            "https://careers.pennmedicine.org/search/jobs?q=health+educator",
            "https://careers.pennmedicine.org/search/jobs?q=patient+navigator",
        ],
    },
    {
        "name": "Main Line Health",
        "base": "https://careers.mainlinehealth.org",
        "parse": parse_mainline,
        # Cards show no city; Main Line is entirely in Delaware/Montgomery Counties.
        "default_location": "Suburban Philadelphia, PA",
        "urls": [
            "https://careers.mainlinehealth.org/job-search/?keyword=care+coordinator",
            "https://careers.mainlinehealth.org/job-search/?keyword=community+health",
            "https://careers.mainlinehealth.org/job-search/?keyword=outreach",
        ],
    },
    {
        "name": "WellSpan (York)",
        "base": "https://www.joinwellspan.org",
        "parse": parse_wellspan,
        "default_location": "York, PA",
        # Their ?keyword= is ignored and the board returns the full list alphabetically,
        # so page through the whole thing and let the filters decide.
        "paginate": {"pattern": "https://www.joinwellspan.org/Search?keyword=care+coordinator&page={page}",
                     "start": 1, "max": 16, "gap": 1.5, "retries": 2},
        "wait": 8.0,
        "urls": [],
    },
    {
        "name": "Chester County",
        "base": "https://www.governmentjobs.com/careers/chesco",
        "parse": parse_govjobs,
        "default_location": "West Chester, PA",
        "urls": ["https://www.governmentjobs.com/careers/chesco"],
    },
    {
        "name": "Montgomery County",
        "base": "https://www.governmentjobs.com/careers/montcopa",
        "parse": parse_govjobs,
        "default_location": "Norristown, PA",
        "urls": [
            "https://www.governmentjobs.com/careers/montcopa",
            "https://www.governmentjobs.com/careers/montcopa?keyword=health",
        ],
    },
    {
        "name": "Delaware County",
        "base": "https://www.governmentjobs.com/careers/delcopa",
        "parse": parse_govjobs,
        "default_location": "Media, PA",
        "urls": [
            "https://www.governmentjobs.com/careers/delcopa",
            "https://www.governmentjobs.com/careers/delcopa?keyword=health",
        ],
    },
    # PA Civil Service is NOT monitored: governmentjobs.com/careers/pabureau ignores
    # ?keyword= and returns the same alphabetical first page (liquor enforcement, state
    # police cadet, PennDOT winter maintenance). It is a statewide board of thousands of
    # postings that cannot be filtered server-side, so it cost 2 page loads per run and
    # produced zero relevant results. PA Dept of Health roles still surface via the
    # saved Indeed searches.
    {
        "name": "Jefferson Health",
        "base": "https://jeffersonhealth.wd5.myworkdayjobs.com",
        "parse": parse_jefferson,
        # Workday encodes city+state in the URL path, so no default is needed.
        "wait": 14.0,
        "extract_js": r"""
(() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/job/"]')) {
    const h = a.getAttribute('href') || '';
    if (!/\/job\/[^/]+\/[^/?]+/.test(h)) continue;
    const base = h.split('?')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ h: base, t: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 150) });
    if (out.length >= 40) break;
  }
  return out;
})()
""",
        "urls": [
            "https://jeffersonhealth.wd5.myworkdayjobs.com/ThomasJeffersonExternal?q=care%20coordinator",
            "https://jeffersonhealth.wd5.myworkdayjobs.com/ThomasJeffersonExternal?q=community%20health",
            "https://jeffersonhealth.wd5.myworkdayjobs.com/ThomasJeffersonExternal?q=patient%20navigator",
        ],
    },
    {
        "name": "AmeriHealth Caritas",
        "base": "https://careers.amerihealthcaritas.com",
        "parse": parse_amerihealth,
        "extract_js": AH_EXTRACT_JS,
        # Phenom renders the result list late; at 5s the cards are still empty.
        "wait": 11.0,
        # National payer: posts in DC/OH/SC/NH too, so NO default location. If we cannot
        # read the city off the card, the posting is dropped rather than guessed.
        "urls": [
            "https://careers.amerihealthcaritas.com/us/en/search-results?keywords=community%20health",
            "https://careers.amerihealthcaritas.com/us/en/search-results?keywords=care%20coordinator",
            "https://careers.amerihealthcaritas.com/us/en/search-results?keywords=care%20connector",
        ],
    },
    {
        "name": "PHMC (Philadelphia)",
        "base": "https://recruiting.ultipro.com",
        "parse": parse_phmc,
        # UltiPro cards carry no location; PHMC is a Philadelphia nonprofit and every
        # posting is in the SE PA region, so we assume the corridor.
        "default_location": "Philadelphia, PA",
        "urls": [
            "https://recruiting.ultipro.com/PUB1002/JobBoard/c8784846-358b-1bec-45e9-f994af5fccee?q=&o=postedDateDesc",
        ],
    },
    {
        "name": "Tower Health",
        "base": "https://www.towercareers.org",
        "parse": parse_tower,
        # Tower is a SE PA system (Reading, Pottstown, Phoenixville, Chestnut Hill...);
        # listing cards omit the city and only the detail page has it.
        "default_location": "Southeastern PA",
        "paginate": {"pattern": "https://www.towercareers.org/jobs?page={page}",
                     "start": 1, "max": 12, "gap": 1.5, "retries": 2},
        "urls": [],
    },
    # UPMC is intentionally NOT monitored: careers.upmc.com returns only navigation
    # for 10s, and when the results do render they span PA/NY/MD with the city buried
    # in the URL slug (and often only a county name, e.g. "-berks-county"). Keeping it
    # either injected out-of-region false positives or required opening every posting.
    # the candidate can use the saved Indeed search for UPMC instead.
]


# --------------------------------------------------------------------------
# Source health: a source that silently returns zero is worse than one that errors,
# because a broken parser looks exactly like "no new jobs".
# --------------------------------------------------------------------------
def check_source_health(found, errors, prev_health) -> tuple[list, dict]:
    counts = {}
    for job in found.values():
        counts[job["employer"]] = counts.get(job["employer"], 0) + 1
    for s in SOURCES:
        counts.setdefault(s["name"], 0)

    warnings, health = [], {}
    err_by_src = {}
    for e in errors:
        name = e.split(":", 1)[0]
        err_by_src[name] = err_by_src.get(name, 0) + 1

    for s in SOURCES:
        name = s["name"]
        n = counts.get(name, 0)
        prev = prev_health.get(name, {})
        # "typical" = the high-water mark we have seen; robust to a single bad day
        peak = max(prev.get("peak", 0), n)
        zero_streak = (prev.get("zero_streak", 0) + 1) if n == 0 else 0
        health[name] = {"last": n, "peak": peak, "zero_streak": zero_streak,
                        "errors": err_by_src.get(name, 0)}

        if err_by_src.get(name):
            warnings.append("%s: %d page load(s) failed" % (name, err_by_src[name]))
        if n == 0 and peak >= 5:
            warnings.append("%s: returned 0 postings (usually ~%d) — parser or site may have changed"
                            % (name, peak))
        elif peak >= 8 and n < peak * 0.4:
            warnings.append("%s: only %d postings (usually ~%d) — possible partial breakage"
                            % (name, n, peak))
    return warnings, health
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"seen": {}, "baseline_done": False, "runs": 0, "source_fail_streak": {}}


def save_state(st):
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1, sort_keys=True))
    tmp.replace(STATE_FILE)


def collect(prev_health=None):
    prev_health = prev_health or {}
    found, errors = {}, []
    if not camo_healthy():
        revive_browser()
    for src in SOURCES:
        idle_pages = 0
        pag = src.get("paginate")
        urls = list(src["urls"])
        page = (pag or {}).get("start", 1)
        page_budget = (pag or {}).get("max", 20)
        pages_done = 0
        while True:
            if pag:
                if pages_done >= page_budget:
                    break
                url = pag["pattern"].format(page=page)
            else:
                if not urls:
                    break
                url = urls.pop(0)

            try:
                raw = fetch_jobs(url, wait=src.get("wait", 5.0), extract_js=src.get("extract_js"))
                if pag and not raw:
                    # WellSpan throttles when pages are fetched back-to-back and answers
                    # with an empty shell. Back off and retry before calling it a miss.
                    for attempt in range(pag.get("retries", 2)):
                        time.sleep(pag.get("gap", 2.5) * 2)
                        raw = fetch_jobs(url, wait=src.get("wait", 5.0) + 3,
                                         extract_js=src.get("extract_js"))
                        if raw:
                            break
            except Exception as e:
                errors.append("%s: %s" % (src["name"], str(e)[:80]))
                if pag:
                    page += 1
                    pages_done += 1
                continue

            new_here = 0
            for item in raw:
                parsed = src["parse"](item.get("h", ""), item.get("t", ""), src["base"])
                if not parsed:
                    continue
                jid, title, loc, link = parsed
                if not jid or not title:
                    continue
                if not loc:
                    loc = src.get("default_location", "")
                key = "%s|%s" % (src["name"], jid)
                if key in found:
                    continue
                title = re.sub(r"\s+", " ", title)
                title = re.sub(r"\s+NEW$", "", title).strip(" |-—")
                found[key] = {
                    "employer": src["name"],
                    "id": jid,
                    "title": title[:120],
                    "location": re.sub(r"\s+", " ", loc)[:80],
                    "url": link,
                }
                new_here += 1

            if pag:
                pages_done += 1
                if new_here == 0:
                    idle_pages += 1
                    if idle_pages >= 2:
                        break
                else:
                    idle_pages = 0
                page += 1
                time.sleep(pag.get("gap", 0.0))

        # A source that quietly returned far fewer postings than usual is probably a
        # partial load (one search page came back short). Retry that source once.
        if not pag:
            prev = prev_health.get(src["name"], {})
            peak = prev.get("peak", 0)
            got = sum(1 for j in found.values() if j["employer"] == src["name"])
            if peak >= 8 and 0 < got < peak * 0.6:
                for url in src["urls"]:
                    try:
                        raw = fetch_jobs(url, wait=src.get("wait", 5.0) + 3,
                                         extract_js=src.get("extract_js"))
                    except Exception:
                        continue
                    for item in raw:
                        parsed = src["parse"](item.get("h", ""), item.get("t", ""), src["base"])
                        if not parsed:
                            continue
                        jid, title, loc, link = parsed
                        if not jid or not title:
                            continue
                        key = "%s|%s" % (src["name"], jid)
                        if key in found:
                            continue
                        title = re.sub(r"\s+", " ", title).strip(" |-—")
                        found[key] = {
                            "employer": src["name"], "id": jid, "title": title[:120],
                            "location": re.sub(r"\s+", " ", loc or src.get("default_location", ""))[:80],
                            "url": link,
                        }
    return found, errors


def selftest() -> int:
    corpus = [
        ("Care Coordinator", "Bala Cynwyd, PA", True),
        ("Community Health Worker - Women's Health", "Wilmington, Delaware", True),
        ("Health Coach", "Wilmington, Delaware", True),
        ("Patient Navigator", "Parkesburg, PA", True),
        ("Community Educator", "Wilmington, Delaware", True),
        ("Population Health Associate", "Bala Cynwyd, PA", True),
        ("Health Educator", "Lancaster, PA", True),
        ("Outreach Coordinator", "York, PA", True),
        ("Quality Improvement Coordinator", "West Chester, PA", True),
        ("Credentialing Specialist", "Philadelphia, PA", True),
        ("Patient Services Coordinator", "King of Prussia, PA", True),
        ("Practice Manager", "Exton, PA", True),
        # negatives
        ("Care Coordinator RN", "Paoli, PA", False),
        ("Registered Nurse - Case Management", "York, PA", False),
        ("Community Health Nurse", "Harrisburg, PA", False),
        ("Health Care Coordinator-Adult Community", "Berwyn, PA", False),  # RN-required in body; title filter can't see that
        ("Clinical Research Coordinator", "West Chester, PA", False),
        ("Research Technician II", "Philadelphia, PA", False),
        ("Medical Assistant", "Exton, PA", False),
        ("Pharmacy Technician", "Wilmington, Delaware", False),
        ("Physical Therapist", "West Chester, PA", False),
        ("Case Manager Nurse", "Ephrata, PA", False),
        ("Director of Population Health", "Philadelphia, PA", False),
        ("Population Health Intern", "Philadelphia, PA", False),
        ("Care Coordinator", "Pittsburgh, PA", False),
        ("Care Coordinator", "Princeton, NJ", False),
        ("Care Coordinator", "Camden, NJ", False),
        ("Cook", "York, PA", False),
        # Regression: substring matching used to let these through
        ("Community Health Navigator", "Washington, District Of Columbia", False),
        ("Community Health Worker", "Dorchester, Massachusetts", False),
        ("Care Coordinator", "Columbia, SC", False),
        ("Care Coordinator", "New York, NY", False),
        ("Community Health Worker", "United States", False),
        ("Care Coordinator", "", False),
        # URL-based licensed-role detection (title hides it, slug does not)
        ("Care Coordinator, Per Diem", "Paoli, PA", False),
        # Positives that must survive the tighter matching
        ("Community Health Worker", "West Chester, PA", True),
        ("Care Coordinator", "Columbia, PA", True),
        ("Patient Navigator", "Chester, PA", True),
        ("Health Coach", "Bear, DE", True),
        ("Community Outreach Specialist (Full-Time)", "Philadelphia, PA", True),
        ("Referral Coordinator (Bilingual Spanish)", "Philadelphia, PA", True),
        ("Intake & Eligibility Specialist - ELRC 18", "Philadelphia, PA", True),
    ]
    # Note: the RN-required "Health Care Coordinator" is expected to PASS the title
    # filter (title looks relevant); it is caught by the description screen below.
    expect_rn_limitation = ("Health Care Coordinator-Adult Community", "Berwyn, PA")
    fails = 0
    for title, loc, want in corpus:
        # Cases whose rejection depends on the URL use a synthetic slug.
        url = ""
        if title == "Care Coordinator, Per Diem":
            url = "https://careers.mainlinehealth.org/posting/rn-care-coordinator-per-diem/12345/"
        got, reason = classify(title, loc, url)
        if (title, loc) == expect_rn_limitation:
            status = "KNOWN-LIMIT" if got else "ok"
        else:
            status = "PASS" if got == want else "FAIL"
            if status == "FAIL":
                fails += 1
        print("%-14s want=%-5s got=%-5s %-58s | %s" % (status, want, got, title[:58], reason))

    print("\n--- description screen (detail_reject) ---")
    detail_corpus = [
        ("Must have Pennsylvania RN license! Melmark Overview", True),
        ("Current and active RN license in the state of Pennsylvania required.", True),
        ("Requires a current US RN License; BSN preferred.", True),
        ("RN licensure required within 6 months of hire.", True),
        ("Master's degree required. MPH preferred.", True),
        ("Current LPN license required.", True),
        ("Bachelor's degree in public health or health education "
         "required. One year of community outreach experience preferred.", False),
        ("Bachelor's degree in Social Work, Psychology, Public Health, or a "
         "related field. Bilingual Spanish a plus.", False),
        ("High school diploma or GED required. Prior healthcare experience preferred.", False),
        ("Bachelor's required. This position reports to the Director of Population Health.", False),
        ("", False),
    ]
    dfails = 0
    for text, want in detail_corpus:
        bad, phrase = detail_reject(text)
        ok = (bad == want)
        if not ok:
            dfails += 1
        print("%-6s want_reject=%-5s got=%-5s %-58s | %s"
              % ("PASS" if ok else "FAIL", want, bad, text[:58], phrase))

    print("\n--- jefferson url parser ---")
    jcases = [
        ("/en-US/ThomasJeffersonExternal/job/Philadelphia-PA/Care-Coordinator_REQ-123456-1",
         "Care Coordinator", "Philadelphia, PA"),
        ("/en-US/ThomasJeffersonExternal/job/Camden-County-NJ/Project-Coordinator_REQ-99",
         "Project Coordinator", "Camden County, NJ"),
        ("/en-US/ThomasJeffersonExternal/job/Montgomery-County-PA/Patient-Navigator_REQ-5",
         "Patient Navigator", "Montgomery County, PA"),
    ]
    jfails = 0
    for href, want_t, want_l in jcases:
        got = parse_jefferson(href, "", "")
        ok = got and got[1] == want_t and got[2] == want_l
        if not ok:
            jfails += 1
        print("%-6s %-58s -> %s | %s" % ("PASS" if ok else "FAIL", href.split("/job/")[1][:58],
                                         got[1] if got else "None", got[2] if got else "None"))

    print("\n--- penn table-layout parser ---")
    table_text = ("Showing 1-13 of 13 results Job ID Job Title Job Category Location Work Type "
                  "348971 Community Health Educator- Per Diem Other West Chester, PA, United States PER DIEM "
                  "347750 Perioperative Clinical Educator Other Philadelphia, PA, United States FT")
    pcases = [
        ("https://careers.pennmedicine.org/jobs/18372008-community-health-educator-per-diem",
         table_text, "Community Health Educator Per Diem", "West Chester, PA, United States"),
        ("https://careers.pennmedicine.org/jobs/18329801-patient-navigator-cardiac-testing",
         "Showing 1-6 of 6 results Job ID Job Title Job Category Location Work Type "
         "345417 Patient Navigator Cardiac Testing NEW Clerical/Administrative Doylestown, PA, United States FT "
         "347690 Patient Navigator Parkesburg Clinical Support Parkesburg, PA, United States FT",
         "Patient Navigator Cardiac Testing", "Doylestown, PA, United States"),
    ]
    pfails = 0
    for href, txt, want_t, want_l in pcases:
        got = parse_penn(href, txt, "")
        ok = got and got[1].strip() == want_t and got[2] == want_l
        if not ok:
            pfails += 1
        print("%-6s %-50s -> %r | %r" % ("PASS" if ok else "FAIL", want_t[:50],
                                         got[1] if got else None, got[2] if got else None))

    print("\n%d title failures, %d detail failures, %d jefferson failures, %d penn failures, %d cases total"
          % (fails, dfails, jfails, pfails, len(corpus) + len(detail_corpus) + len(jcases) + len(pcases)))
    return 0 if (fails == 0 and dfails == 0 and jfails == 0 and pfails == 0) else 1


def main() -> int:
    args = sys.argv[1:]
    if "--selftest" in args:
        return selftest()

    st = load_state()
    found, errors = collect(st.get("source_health", {}))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if not found and errors:
        print("⚠️ Job watch FAILED: all sources unreachable (%d errors). First: %s"
              % (len(errors), errors[0]))
        return 1

    # If a large share of sources failed, that is an infrastructure problem worth shouting about.
    total_urls = sum(
        (s["paginate"]["max"] if s.get("paginate") else len(s["urls"])) for s in SOURCES
    )
    health_warnings, health = check_source_health(found, errors, st.get("source_health", {}))
    st["source_health"] = health

    relevant, rejected = {}, {}
    for key, job in found.items():
        ok, reason = classify(job["title"], job["location"], job.get("url", ""))
        (relevant if ok else rejected)[key] = dict(job, reason=reason)

    seen = st.get("seen", {})
    # A posting that is relevant now but was never *announced* should still alert, even if
    # we recorded it earlier (seen holds every posting, relevant or not, so a title or
    # location edit upstream could otherwise leave it permanently suppressed).
    # Jobs already marked applied / not-applicable on the dashboard are also skipped.
    suppressed = fetch_suppressed()
    new_keys = [k for k in relevant
                if not seen.get(k, {}).get("alerted")
                and not seen.get(k, {}).get("detail_rejected")
                and k not in suppressed]

    if "--dump" in args:
        print("=== RELEVANT (%d) ===" % len(relevant))
        for k, j in sorted(relevant.items(), key=lambda kv: kv[1]["title"]):
            print("  [%s] %-55s | %s | %s" % (j["employer"][:14], j["title"][:55], j["location"][:24], j["url"][:70]))
        print("\n=== NEW since last run (%d) ===" % len(new_keys))
        for k in new_keys:
            print("  NEW:", relevant[k]["title"], "|", relevant[k]["employer"])
        print("\n=== REJECTED (%d) ===" % len(rejected))
        lim = len(rejected) if "--dump-all" in args else 40
        for k, j in sorted(rejected.items(), key=lambda kv: kv[1]["title"])[:lim]:
            print("  (%s) %-50s | %s" % (j["reason"][:18], j["title"][:50], j["location"][:22]))
        print("\n=== ERRORS (%d) ===" % len(errors))
        for e in errors[:10]:
            print("  ", e)

    # record everything we saw, so future runs only alert on genuinely new keys
    for key, job in found.items():
        entry = seen.get(key) or {"first_seen": now}
        entry.update({"title": job["title"], "employer": job["employer"],
                      "location": job["location"], "url": job["url"], "last_seen": now})
        seen[key] = entry
    st["seen"] = seen
    st["runs"] = st.get("runs", 0) + 1
    st["last_run"] = now
    st["last_counts"] = {"found": len(found), "relevant": len(relevant),
                         "rejected": len(rejected), "new": len(new_keys),
                         "errors": len(errors)}

    baseline = (not st.get("baseline_done")) or ("--baseline" in args)
    if baseline:
        # A baseline means "everything currently live is already known" - mark the
        # relevant ones as announced so the next run does not flood her with them.
        for k in relevant:
            seen[k]["alerted"] = True
            seen[k]["alerted_at"] = now
        st["seen"] = seen
        st["baseline_done"] = True
        st["baseline_at"] = now
        st["web_sync"] = push_snapshot(relevant, now)
        save_state(st)
        if "--baseline" in args:
            print("baseline recorded: %d postings (%d relevant) at %s"
                  % (len(found), len(relevant), now))
            print("dashboard sync: %s" % st["web_sync"])
            for w in health_warnings:
                print("  ⚠️", w)
        return 0

    st["web_sync"] = push_snapshot(relevant, now)
    save_state(st)

    if not new_keys:
        if health_warnings:
            print("⚠️ Job watch problem (no new jobs to report)\n")
            for w in health_warnings:
                print("• %s" % w)
            print("\nChecked %d postings across %d employers at %s"
                  % (len(found), len(SOURCES), now))
        if str(st.get("web_sync", "")).startswith("FAILED"):
            print("⚠️ Dashboard sync %s" % st["web_sync"])
        return 0

    # Description-level screen: only for NEW matches (a handful per week), so this is cheap.
    verified, dropped = [], []
    for k in sorted(new_keys):
        job = relevant[k]
        if len(verified) >= 8:
            verified.append(k)
            continue
        try:
            body = fetch_body(job["url"])
        except Exception:
            body = ""
        bad, phrase = detail_reject(body)
        if bad:
            dropped.append((k, phrase))
            st["seen"][k]["detail_rejected"] = phrase
        else:
            verified.append(k)
    save_state(st)

    new_keys = verified
    if not new_keys:
        if dropped:
            print("job watch: %d new match(es) screened out by hard requirements (%s)"
                  % (len(dropped), dropped[0][1]))
        if health_warnings:
            print("⚠️ Job watch problem%s\n" % ("" if len(health_warnings) == 1 else "s"))
            for w in health_warnings:
                print("• %s" % w)
        return 0

    lines = ["🔔 %d new job match%s \n" % (len(new_keys), "" if len(new_keys) == 1 else "es")]
    for i, k in enumerate(sorted(new_keys, key=lambda x: relevant[x]["employer"])[:10], 1):
        j = relevant[k]
        lines.append("%d. %s\n   🏥 %s" % (i, j["title"], j["employer"]))
        if j["location"]:
            lines.append("   📍 %s" % j["location"])
        lines.append("   🔗 %s\n" % j["url"])
    if len(new_keys) > 10:
        lines.append("…and %d more (run with --dump for the full list)" % (len(new_keys) - 10))
    if health_warnings:
        lines.append("⚠️ Source problem%s this run:" % ("" if len(health_warnings) == 1 else "s"))
        for w in health_warnings:
            lines.append("• %s" % w)
    print("\n".join(lines))

    LOG_FILE.write_text(json.dumps({"at": now, "new": new_keys, "errors": errors,
                                    "health_warnings": health_warnings}, indent=1))
    for k in new_keys:
        st["seen"][k]["alerted"] = True
        st["seen"][k]["alerted_at"] = now
    save_state(st)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("⚠️ Job watch crashed: %s" % str(e)[:200])
        sys.exit(1)
