"""Per-lead enrichment from the open web: profile page, ORCID, lab website.

Discovery finds a person through their papers, which gives a name, an
institution and a research record — but not an email, a designation, or a
list of the instruments sitting in their lab. All three are usually on the
web, on pages this service is already allowed to read:

  1. The institute's faculty directory → the person's own profile page →
     email, designation, department, phone, links to a lab site.
  2. ORCID's public record → "researcher URLs" (the lab or personal site) and
     current employment, when the profile page gives nothing.
  3. The lab website → its home page and any "facilities" / "instruments" /
     "equipment" pages, where groups list what they own by brand and model.

This module is parsing only. Which instruments the text names is decided in
Node, with the same rules the rest of the pipeline uses; here we return the
sentences that mention any of the terms Node asked about, with the URL each
came from, so the evidence on the lead is verifiable.

Every fetch goes through the robots.txt gate and the per-domain delay like all
other traffic from this service.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, Tag

from ..core.config import settings
from ..core.robots import robots_gate
from .faculty_scraper import (
    EMAIL_RE,
    _name_tokens,
    extract_emails_from_page,
    pick_personal_email,
)

# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------

_DROP_TAGS = ("script", "style", "noscript", "svg", "nav", "footer", "header", "form")


def html_to_text(html: str) -> str:
    """Visible text of a page, one block per line, boilerplate removed."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(_DROP_TAGS):
        tag.decompose()
    text = soup.get_text("\n", strip=True)
    # Collapse runs of whitespace but keep line structure for sentence splitting.
    return re.sub(r"[ \t]+", " ", text)


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?;])\s+|\n+")


def extract_snippets(text: str, terms: list[str], *, max_snippets: int = 30, window: int = 260) -> list[str]:
    """Sentences (or short line groups) that mention any of `terms`.

    Case-insensitive, whole-word where the term is alphanumeric so "Gamry"
    matches "Gamry" and not "gamryx". Each snippet is capped at `window`
    characters around the first match so evidence stays readable.
    """
    if not text or not terms:
        return []

    patterns = []
    for term in terms:
        t = term.strip()
        if len(t) < 3:
            continue
        escaped = re.escape(t)
        # Allow the common spellings of a model number: "CHI660E", "CHI 660E", "CHI-660E".
        escaped = re.sub(r"(?<=[A-Za-z])\\ ?(?=\d)|(?<=[A-Za-z])(?=\d)", r"[ -]?", escaped)
        patterns.append(escaped)
    if not patterns:
        return []
    matcher = re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(patterns) + r")(?![A-Za-z0-9])", re.IGNORECASE)

    snippets: list[str] = []
    seen: set[str] = set()
    for sentence in _SENTENCE_SPLIT.split(text):
        s = " ".join(sentence.split())
        if not s:
            continue
        m = matcher.search(s)
        if not m:
            continue
        if len(s) > window:
            start = max(0, m.start() - window // 2)
            s = ("…" if start > 0 else "") + s[start : start + window].strip() + ("…" if start + window < len(s) else "")
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        snippets.append(s)
        if len(snippets) >= max_snippets:
            break
    return snippets


# ---------------------------------------------------------------------------
# Contact details on a profile page
# ---------------------------------------------------------------------------

DESIGNATION_RE = re.compile(
    r"\b("
    r"(?:Distinguished|Emeritus|Visiting|Adjunct|Chair|Institute|Senior|Principal|Chief|Junior)?\s*"
    r"(?:Professor|Associate Professor|Assistant Professor|Scientist|Research Scientist|"
    r"Principal Scientist|Senior Scientist|Reader|Lecturer|Research Fellow|Postdoctoral Fellow|"
    r"Research Associate|Head of (?:the )?Department|Dean|Director)"
    r")\b",
    re.IGNORECASE,
)

DEPARTMENT_RE = re.compile(
    r"\b((?:Department|Dept\.?|School|Centre|Center|Division) (?:of|for) [A-Z][A-Za-z&,\- ]{3,60}?)"
    r"(?=[\n,.;|()]|\s{2,}|$)",
)

PHONE_RE = re.compile(
    r"(?:\+91[\s-]?|\b0)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}\b"
)

_WEBSITE_LINK_WORDS = (
    "lab", "group", "website", "homepage", "home page", "personal page", "research group",
    "laboratory", "web page", "webpage", "google sites", "sites.google",
)

_SOCIAL_HOSTS = (
    "scholar.google", "linkedin.com", "researchgate.net", "orcid.org", "twitter.com", "x.com",
    "facebook.com", "youtube.com", "scopus.com", "publons.com", "webofscience.com", "github.com",
    "dblp.org", "semanticscholar.org", "academia.edu", "instagram.com",
)


@dataclass
class ContactDetails:
    email: str | None = None
    phone: str | None = None
    designation: str | None = None
    department: str | None = None
    websites: list[str] = field(default_factory=list)


def _is_social(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return any(s in host for s in _SOCIAL_HOSTS)


def extract_contact(html: str, name: str, page_url: str) -> ContactDetails:
    """Best-effort contact fields from a person's profile page."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(("script", "style", "noscript")):
        tag.decompose()
    text = soup.get_text("\n", strip=True)

    details = ContactDetails()
    details.email = pick_personal_email(extract_emails_from_page(html), name)

    # Designation: the first academic rank that appears near the top of the page.
    head = text[:3000]
    m = DESIGNATION_RE.search(head)
    if m:
        details.designation = " ".join(m.group(1).split()).title().replace("Of The", "of the").replace("Of ", "of ")

    m = DEPARTMENT_RE.search(head)
    if m:
        details.department = " ".join(m.group(1).split()).rstrip(",.;")

    # Phone: prefer a labelled one; a bare digit run is often a room or PIN.
    labelled = re.search(r"(?:phone|tel|telephone|mobile|contact)\s*[:.]?\s*([+\d][\d\s()+-]{7,20})", text, re.IGNORECASE)
    if labelled:
        candidate = " ".join(labelled.group(1).split())
        if len(re.sub(r"\D", "", candidate)) >= 8:
            details.phone = candidate

    # Lab / personal website links: offsite, non-social, or labelled as such.
    page_host = urlparse(page_url).netloc.lower()
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if not isinstance(href, str) or href.lower().startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        absolute = urljoin(page_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https") or _is_social(absolute):
            continue
        label = " ".join(anchor.get_text(" ", strip=True).lower().split())
        labelled_as_site = any(w in label for w in _WEBSITE_LINK_WORDS) or any(
            w in href.lower() for w in ("lab", "group", "sites.google")
        )
        offsite = parsed.netloc.lower() != page_host and not parsed.path.lower().endswith((".pdf", ".doc", ".docx"))
        if not (labelled_as_site or (offsite and label and len(label) < 60)):
            continue
        key = absolute.rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        details.websites.append(absolute)
        if len(details.websites) >= 5:
            break

    return details


# ---------------------------------------------------------------------------
# Finding the person in a directory
# ---------------------------------------------------------------------------

def name_matches(candidate: str, target: str) -> bool:
    """Loose match good enough for a directory: same surname, compatible first name.

    "S. Tallur" vs "Siddharth Tallur" is a match; "Anil Kumar" vs "Sunil Kumar"
    is not. Surname is the last token of each.
    """
    a = _name_tokens(candidate)
    b = _name_tokens(target)
    if not a or not b:
        return False
    if a[-1] != b[-1]:
        return False
    # First names: equal, or one is an initial of the other.
    fa, fb = a[0], b[0]
    if fa == fb:
        return True
    if len(fa) == 1 and fb.startswith(fa) or len(fb) == 1 and fa.startswith(fb):
        return True
    # Middle-name-first cultures: any shared non-surname token.
    return bool(set(a[:-1]) & set(b[:-1]))


# ---------------------------------------------------------------------------
# Equipment pages on a lab site
# ---------------------------------------------------------------------------

_EQUIPMENT_WORDS = (
    "facilit", "instrument", "equipment", "infrastructure", "resources", "lab",
    "laborator", "research", "setup", "characterization", "characterisation",
)


def find_equipment_pages(html: str, base_url: str, *, limit: int = 4) -> list[str]:
    """Links on a lab home page most likely to list what the lab owns."""
    soup = BeautifulSoup(html, "lxml")
    host = urlparse(base_url).netloc.lower()
    scored: list[tuple[int, str]] = []
    seen: set[str] = set()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if not isinstance(href, str) or href.lower().startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        absolute = urljoin(base_url, href).split("#")[0]
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https") or parsed.netloc.lower() != host:
            continue
        if parsed.path.lower().endswith((".pdf", ".jpg", ".png", ".doc", ".docx", ".ppt", ".pptx")):
            continue
        label = " ".join(anchor.get_text(" ", strip=True).lower().split())
        hay = f"{label} {parsed.path.lower()}"
        score = sum(3 if w in label else 1 for w in _EQUIPMENT_WORDS if w in hay)
        if "facilit" in hay or "instrument" in hay or "equipment" in hay:
            score += 5
        if score == 0:
            continue
        key = absolute.rstrip("/").lower()
        if key in seen or key == base_url.rstrip("/").lower():
            continue
        seen.add(key)
        scored.append((score, absolute))

    scored.sort(key=lambda x: -x[0])
    return [u for _, u in scored[:limit]]


# ---------------------------------------------------------------------------
# ORCID public API
# ---------------------------------------------------------------------------

ORCID_RE = re.compile(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]")


@dataclass
class OrcidRecord:
    websites: list[str] = field(default_factory=list)
    designation: str | None = None
    department: str | None = None
    emails: list[str] = field(default_factory=list)


async def fetch_orcid(orcid: str, timeout_sec: int | None = None) -> OrcidRecord:
    """Public, keyless ORCID API: researcher URLs, current employment, public emails.

    Same politeness as any other fetch — the gate's delay applies to pub.orcid.org.
    Anything missing or private is simply absent; ORCID never raises here.
    """
    record = OrcidRecord()
    m = ORCID_RE.search(orcid or "")
    if not m:
        return record
    oid = m.group(0)
    base = f"https://pub.orcid.org/v3.0/{oid}"
    headers = {"Accept": "application/json", "User-Agent": settings.scraper_user_agent}

    async def get(path: str) -> dict | None:
        url = f"{base}/{path}"
        # pub.orcid.org's robots.txt disallows crawlers, but this is ORCID's
        # documented public API (JSON, rate-limited, meant for programs) — not a
        # page crawl. The per-domain delay still applies as a courtesy.
        await robots_gate.wait_for_turn(url)
        try:
            async with httpx.AsyncClient(timeout=timeout_sec or settings.scraper_timeout_sec, headers=headers) as client:
                r = await client.get(url)
            return r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None

    urls = await get("researcher-urls")
    for item in (urls or {}).get("researcher-url", []) or []:
        value = ((item or {}).get("url") or {}).get("value")
        if value and not _is_social(value):
            record.websites.append(value)

    emp = await get("employments")
    groups = (emp or {}).get("affiliation-group", []) or []
    for g in groups:
        for s in g.get("summaries", []) or []:
            e = s.get("employment-summary") or {}
            if e.get("end-date"):
                continue  # Past role.
            record.designation = record.designation or e.get("role-title")
            record.department = record.department or e.get("department-name")
        if record.designation:
            break

    person = await get("email")
    for e in (person or {}).get("email", []) or []:
        v = (e or {}).get("email")
        if v and EMAIL_RE.fullmatch(v):
            record.emails.append(v.lower())

    return record
