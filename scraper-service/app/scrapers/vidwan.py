"""Vidwan (vidwan.inflibnet.ac.in) — India's national researcher database.

Ported from the project owner's `vidwan_search_to_dataframe` notebook on
20 Sep 2026, at their decision: Vidwan's robots.txt disallows crawlers, and
the owner chose to use its public search regardless, so this module — alone
in the service — does not consult the robots gate. What it keeps: one
session, the per-domain courtesy delay on every request, sequential profile
fetches, and a hard stop on the first 403/429 (`VidwanBlocked`). What it does
not do: rotate identities, retry through a browser or proxy, or pretend a
block did not happen.

Flow (Vidwan is a Laravel app):
    GET  /profiles                 -> CSRF token
    POST /profiles/apply-filters   -> filtered listing, page 1 (session-held filter)
    GET  /profiles?page=N          -> further pages of the same filter
    GET  /profile/<id>             -> one researcher's page

Profile parsing is layered and generic — definition lists, label/value
tables, "Label: value" lines, JSON-LD, mailto links — with the page's visible
text returned whole, so a layout change degrades to "less structure", never
to silently wrong fields.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, Tag

from ..core.config import settings
from ..core.robots import robots_gate

BASE_URL = "https://vidwan.inflibnet.ac.in"
PROFILES_URL = f"{BASE_URL}/profiles"
FILTER_URL = f"{BASE_URL}/profiles/apply-filters"

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(?:\+91[\s-]?)?(?:\(?0?\d{2,5}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}")

# Label spellings seen on Vidwan profiles, most specific first per field.
FIELD_LABELS: dict[str, tuple[str, ...]] = {
    "name": ("name", "full name", "researcher name"),
    "designation": ("designation", "current designation", "position"),
    "institute": ("institute", "institution", "organization", "organisation", "affiliation", "university"),
    "department": ("department", "dept", "department/centre", "department / centre", "school"),
    "state": ("state", "location"),
    "email": ("email", "email id", "e-mail", "official email"),
    "phone": ("phone", "mobile", "contact number", "telephone", "contact no"),
    "website": ("website", "web site", "homepage", "personal website", "url"),
    "expertise": ("expertise", "area of expertise", "areas of expertise", "research interests", "subject expertise", "specialization", "specialisation", "keywords", "broad area"),
    "orcid": ("orcid", "orcid id", "orcid identifier"),
}


class VidwanBlocked(Exception):
    """Vidwan refused us (403/429). The caller stops; nothing tries to get around it."""


@dataclass
class VidwanListing:
    vidwan_id: str
    profile_url: str
    listing_name: str
    card_text: str


@dataclass
class VidwanProfile:
    vidwan_id: str
    profile_url: str
    name: str = ""
    designation: str = ""
    institute: str = ""
    department: str = ""
    state: str = ""
    email: str = ""
    phone: str = ""
    website: str = ""
    expertise: str = ""
    orcid: str = ""
    profile_text: str = ""
    structured: dict[str, str] = field(default_factory=dict)
    error: str = ""


def _clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _csrf_token(soup: BeautifulSoup) -> str | None:
    token = soup.find("input", {"name": "_token"})
    if isinstance(token, Tag) and token.get("value"):
        return str(token["value"])
    meta = soup.find("meta", {"name": "csrf-token"})
    if isinstance(meta, Tag) and meta.get("content"):
        return str(meta["content"])
    return None


def parse_listing(html: str, base_url: str = BASE_URL) -> list[VidwanListing]:
    """Researcher cards on a listing page: every /profile/<digits> link, once."""
    soup = BeautifulSoup(html, "lxml")
    out: list[VidwanListing] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not isinstance(href, str):
            continue
        absolute = urljoin(base_url, href.strip())
        path = urlparse(absolute).path.rstrip("/")
        if not path.startswith("/profile/"):
            continue
        vid = path.split("/")[-1]
        if not vid.isdigit() or vid in seen:
            continue
        seen.add(vid)
        # The card around the link carries designation/institute on the listing
        # itself — useful when the profile page cannot be fetched.
        node: Tag | None = a
        card = _clean(a.get_text(" ", strip=True))
        for _ in range(6):
            node = node.parent if isinstance(node, Tag) else None
            if node is None:
                break
            text = _clean(node.get_text(" ", strip=True))
            if len(text) > 40 and len(text) < 2500:
                card = text
                if "view profile" in text.lower() or len(text) > 120:
                    break
        out.append(VidwanListing(vidwan_id=vid, profile_url=absolute, listing_name=_clean(a.get_text(" ", strip=True)), card_text=card))
    return out


def parse_pagination(html: str, page_url: str = BASE_URL, site_root: str = BASE_URL) -> list[str]:
    """/profiles?page=N links on a listing page, ascending, rebuilt on the site root."""
    soup = BeautifulSoup(html, "lxml")
    pages: dict[int, str] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not isinstance(href, str):
            continue
        absolute = urljoin(page_url, href.strip())
        parsed = urlparse(absolute)
        if parsed.path.rstrip("/") != "/profiles":
            continue
        n = parse_qs(parsed.query).get("page", [None])[0]
        if n and str(n).isdigit():
            pages[int(n)] = f"{site_root.rstrip('/')}/profiles?page={int(n)}"
    return [pages[k] for k in sorted(pages)]


def _label_value_pairs(soup: BeautifulSoup) -> dict[str, str]:
    """Label → value from <dt>/<dd>, two-cell table rows and "Label: value" lines."""
    data: dict[str, str] = {}

    def put(key: str, value: str) -> None:
        key = _clean(key).rstrip(":").strip().lower()
        value = _clean(value)
        if key and value and len(key) < 60 and key not in data:
            data[key] = value

    for dt in soup.find_all("dt"):
        dd = dt.find_next_sibling("dd")
        if dd:
            put(dt.get_text(" ", strip=True), dd.get_text(" ", strip=True))

    for row in soup.find_all("tr"):
        cells = row.find_all(["th", "td"])
        if len(cells) >= 2:
            put(cells[0].get_text(" ", strip=True), " ".join(c.get_text(" ", strip=True) for c in cells[1:]))

    # "<strong>Designation</strong>: Professor" and "<label>Institute</label><span>IIT Bombay</span>"
    for lab in soup.find_all(["strong", "b", "label", "th", "span", "div", "p", "li", "h5", "h6"]):
        text = _clean(lab.get_text(" ", strip=True))
        if not text or len(text) > 200:
            continue
        m = re.match(r"^([A-Za-z][A-Za-z /]{1,40}?)\s*:\s*(.+)$", text)
        if m:
            put(m.group(1), m.group(2))
            continue
        if lab.name in ("strong", "b", "label", "th") and len(text) < 40:
            sib = lab.find_next_sibling()
            if isinstance(sib, Tag):
                value = _clean(sib.get_text(" ", strip=True))
                if value and not value.endswith(":"):
                    put(text, value)
    return data


def parse_profile(html: str, vidwan_id: str, profile_url: str) -> VidwanProfile:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(["script", "style", "nav", "footer"]):
        if tag.name == "script" and tag.get("type") == "application/ld+json":
            continue
        tag.decompose()

    structured = _label_value_pairs(soup)
    profile = VidwanProfile(vidwan_id=vidwan_id, profile_url=profile_url, structured=structured)

    for field_name, labels in FIELD_LABELS.items():
        for label in labels:
            if label in structured:
                setattr(profile, field_name, structured[label])
                break

    # JSON-LD (schema.org/Person) when present.
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or script.get_text() or "{}")
        except ValueError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            profile.name = profile.name or _clean(str(item.get("name") or ""))
            profile.designation = profile.designation or _clean(str(item.get("jobTitle") or ""))
            org = item.get("worksFor") or item.get("affiliation")
            if isinstance(org, dict):
                profile.institute = profile.institute or _clean(str(org.get("name") or ""))
            profile.email = profile.email or _clean(str(item.get("email") or "")).replace("mailto:", "")
            profile.phone = profile.phone or _clean(str(item.get("telephone") or ""))
            profile.website = profile.website or _clean(str(item.get("url") or ""))

    # Name from the page heading when no label gave one.
    if not profile.name:
        h = soup.find(["h1", "h2", "h3"])
        if h:
            profile.name = _clean(h.get_text(" ", strip=True))

    # mailto beats a regex over text, which picks up the site's own address.
    if not profile.email:
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if isinstance(href, str) and href.lower().startswith("mailto:"):
                addr = href[7:].split("?")[0].strip().lower()
                if EMAIL_RE.fullmatch(addr) and "inflibnet" not in addr:
                    profile.email = addr
                    break
    if profile.email and not EMAIL_RE.fullmatch(profile.email.lower()):
        m = EMAIL_RE.search(profile.email)
        profile.email = m.group(0).lower() if m else ""
    profile.email = profile.email.lower()

    orcid = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", profile.orcid or html)
    profile.orcid = orcid.group(0) if orcid else ""

    profile.profile_text = _clean(soup.get_text(" ", strip=True))[:6000]
    profile.name = re.sub(r"^(dr|prof|professor|mr|mrs|ms)\.?\s+", "", profile.name, flags=re.I).strip() or profile.name
    return profile


class VidwanClient:
    """One cookie-holding session for a search and its profile fetches."""

    def __init__(self, timeout_sec: int | None = None, base_url: str = BASE_URL) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            timeout=timeout_sec or settings.scraper_timeout_sec,
            follow_redirects=True,
            headers={
                "User-Agent": settings.vidwan_user_agent or settings.scraper_user_agent,
                "Accept-Language": "en-IN,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        self.requests = 0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        # The courtesy delay applies even though the robots rules do not.
        await robots_gate.wait_for_turn(url)
        self.requests += 1
        response = await self._client.request(method, url, **kwargs)
        if response.status_code in (403, 429):
            raise VidwanBlocked(f"HTTP {response.status_code} from {urlparse(url).netloc}")
        response.raise_for_status()
        return response

    async def search(self, query: str, *, limit: int = 12, max_pages: int = 50) -> tuple[list[VidwanListing], int]:
        """All listing cards for one query; returns (listings, pages fetched)."""
        profiles_url = f"{self.base_url}/profiles"
        landing = await self._request("GET", profiles_url)
        token = _csrf_token(BeautifulSoup(landing.text, "lxml"))
        if not token:
            raise RuntimeError("Vidwan search page has no CSRF token — the site layout has changed")

        first = await self._request(
            "POST",
            f"{self.base_url}/profiles/apply-filters",
            data={"_token": token, "q": query, "sortfield": "first_name", "limits": str(limit)},
            headers={"Referer": profiles_url, "Origin": self.base_url},
        )

        listings: list[VidwanListing] = []
        seen: set[str] = set()
        visited: set[str] = set()

        def absorb(html: str, base: str) -> int:
            new = 0
            for item in parse_listing(html, base):
                if item.vidwan_id not in seen:
                    seen.add(item.vidwan_id)
                    listings.append(item)
                    new += 1
            return new

        pages = 1
        visited.add(str(first.url))
        absorb(first.text, str(first.url))
        queue = [u for u in parse_pagination(first.text, str(first.url), self.base_url) if u not in visited]

        while queue and pages < max_pages:
            url = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)
            page = await self._request("GET", url)
            pages += 1
            new = absorb(page.text, url)
            # A page that adds nothing means the session's filter has been lost
            # (or the listing looped) — going on would crawl the whole site.
            if new == 0:
                break
            for nxt in parse_pagination(page.text, url, self.base_url):
                if nxt not in visited and nxt not in queue:
                    queue.append(nxt)
        return listings, pages

    async def profile(self, listing: VidwanListing) -> VidwanProfile:
        response = await self._request("GET", listing.profile_url)
        profile = parse_profile(response.text, listing.vidwan_id, listing.profile_url)
        if not profile.name:
            profile.name = listing.listing_name
        # The listing card often states designation and institute even when the
        # profile page's markup defeats the label parser.
        if not profile.designation or not profile.institute:
            card = listing.card_text
            for field_name in ("designation", "institute", "department"):
                if getattr(profile, field_name):
                    continue
                for label in FIELD_LABELS[field_name]:
                    m = re.search(rf"\b{re.escape(label)}\s*:?\s*([^|•\n]{{3,120}}?)(?=\s+(?:{'|'.join(sum(FIELD_LABELS.values(), ()))})\b\s*:|$)", card, re.I)
                    if m:
                        setattr(profile, field_name, _clean(m.group(1)))
                        break
        return profile
