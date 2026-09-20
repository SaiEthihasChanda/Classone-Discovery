"""Vidwan (vidwan.inflibnet.ac.in) — India's national researcher database.

Ported from the project owner's `vidwan_search_to_dataframe` notebook on
20 Sep 2026, at their decision: Vidwan's robots.txt disallows crawlers, and
the owner chose to use its public search regardless, so this module — alone
in the service — does not consult the robots gate and paces itself instead:
one session, at most `vidwan_concurrency` requests in flight, request starts
at least `vidwan_delay_ms` apart (owner's setting, 20 Sep 2026: 3 / 500 ms),
and a hard stop on the first 403/429 (`VidwanBlocked`). What it does not do:
rotate identities, retry through a browser or proxy, or pretend a block did
not happen.

Verified against the live site on 20 Sep 2026 (Laravel app):
    GET  /profiles                  form: _token, q, subject[], expertise[],
                                    sortfield (first_name|organization_name),
                                    limits (12|24|48)
    POST /profiles/apply-filters    -> listing page 1; the filter is held in
                                    the session. "N Total Experts found".
    GET  /profiles?page=N           -> page N of the SAME filter, 1-indexed
                                    (page=1 is page 1; the "page=0" link the
                                    site emits is a duplicate of it)
    GET  /profile/<id>              -> hero card: name, gender, degree,
                                    designation | department, institute
                                    (years), state, Expertise badges,
                                    ORCID / Scopus / Google Scholar badges.
                                    No email or phone is published.

Listing cards (`.exp-card`) already carry name, designation, broad subject
and institute, so the role filter can run before any profile is fetched.
Every selector has a text-based fallback so a redesign degrades to "less
structure", never to wrong fields.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, Tag

from ..core.config import settings

BASE_URL = "https://vidwan.inflibnet.ac.in"
PAGE_SIZE = 48

ORCID_RE = re.compile(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]")
TOTAL_RE = re.compile(r"([\d,]+)\s*Total Experts", re.I)

# Card designations that are never faculty — their profiles are not fetched.
STUDENT_ROLE_RE = re.compile(
    r"\b(student|scholar|ph\.?\s?d|doctoral|post[\s-]?doc|research fellow|jrf|srf|project (fellow|assistant|associate|staff)|intern|trainee)\b",
    re.I,
)


class VidwanBlocked(Exception):
    """Vidwan refused us (403/429). The caller stops; nothing tries to get around it."""


@dataclass
class VidwanListing:
    vidwan_id: str
    profile_url: str
    listing_name: str
    designation: str = ""
    subject: str = ""
    institute: str = ""
    location: str = ""
    card_text: str = ""


@dataclass
class VidwanProfile:
    vidwan_id: str
    profile_url: str
    name: str = ""
    designation: str = ""
    institute: str = ""
    department: str = ""
    years: str = ""
    state: str = ""
    expertise: str = ""
    orcid: str = ""
    scopus_id: str = ""
    scholar_id: str = ""
    website: str = ""
    profile_text: str = ""
    structured: dict[str, str] = field(default_factory=dict)


def _clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _strip_honorific(name: str) -> str:
    return re.sub(r"^(?:(dr|prof|professor|mr|mrs|ms|shri|smt)\.?\s+)+", "", _clean(name), flags=re.I).strip() or _clean(name)


def _csrf_token(soup: BeautifulSoup) -> str | None:
    token = soup.find("input", {"name": "_token"})
    if isinstance(token, Tag) and token.get("value"):
        return str(token["value"])
    meta = soup.find("meta", {"name": "csrf-token"})
    if isinstance(meta, Tag) and meta.get("content"):
        return str(meta["content"])
    return None


def parse_total(html: str) -> int | None:
    m = TOTAL_RE.search(re.sub(r"\s+", " ", html))
    return int(m.group(1).replace(",", "")) if m else None


def _profile_id(href: str, base_url: str) -> tuple[str, str] | None:
    absolute = urljoin(base_url, href.strip())
    path = urlparse(absolute).path.rstrip("/")
    if not path.startswith("/profile/"):
        return None
    vid = path.split("/")[-1]
    return (vid, absolute) if vid.isdigit() else None


def parse_listing(html: str, base_url: str = BASE_URL) -> list[VidwanListing]:
    """Researcher cards on a listing page, once each."""
    soup = BeautifulSoup(html, "lxml")
    out: list[VidwanListing] = []
    seen: set[str] = set()

    cards = soup.select(".exp-card")
    if cards:
        for card in cards:
            link = card.select_one(".exp-title a[href]") or card.find("a", href=re.compile(r"/profile/\d+"))
            if not isinstance(link, Tag):
                continue
            ident = _profile_id(str(link["href"]), base_url)
            if not ident or ident[0] in seen:
                continue
            seen.add(ident[0])
            role = card.select_one(".exp-role-text")
            subject = card.select_one(".adv-pill-text")
            inst = card.select_one(".exp-meta-row-university span")
            loc = card.select_one(".exp-meta-row-location span")
            out.append(
                VidwanListing(
                    vidwan_id=ident[0],
                    profile_url=ident[1],
                    listing_name=_strip_honorific(link.get_text(" ", strip=True)),
                    designation=_clean(role.get_text(" ", strip=True)) if role else "",
                    subject=_clean(subject.get_text(" ", strip=True)) if subject else "",
                    institute=_clean(inst.get_text(" ", strip=True)) if inst else "",
                    location=_clean(loc.get_text(" ", strip=True)) if loc else "",
                    card_text=_clean(card.get_text(" ", strip=True))[:600],
                )
            )
        return out

    # Fallback: any /profile/<id> link, with the surrounding text as the card.
    for a in soup.find_all("a", href=True):
        ident = _profile_id(str(a["href"]), base_url)
        if not ident or ident[0] in seen:
            continue
        seen.add(ident[0])
        node: Tag | None = a
        card = _clean(a.get_text(" ", strip=True))
        for _ in range(6):
            node = node.parent if isinstance(node, Tag) else None
            if node is None:
                break
            text = _clean(node.get_text(" ", strip=True))
            if 40 < len(text) < 2500:
                card = text
                if "view profile" in text.lower() or len(text) > 120:
                    break
        out.append(VidwanListing(vidwan_id=ident[0], profile_url=ident[1], listing_name=_strip_honorific(a.get_text(" ", strip=True)), card_text=card[:600]))
    return out


def parse_profile(html: str, vidwan_id: str, profile_url: str) -> VidwanProfile:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(["script", "style"]):
        tag.decompose()
    p = VidwanProfile(vidwan_id=vidwan_id, profile_url=profile_url)

    name = soup.select_one(".custom_hero_name") or soup.find(["h1", "h2"])
    if name:
        p.name = _strip_honorific(name.get_text(" ", strip=True))

    # The hero grid: the icon on each item says what it is.
    for item in soup.select(".custom_hero_info_item"):
        icon = item.find("i")
        classes = " ".join(icon.get("class", [])) if isinstance(icon, Tag) else ""
        strong = item.find("strong")
        sub = item.select_one(".info_sub")
        main = _clean(strong.get_text(" ", strip=True)) if strong else _clean(item.get_text(" ", strip=True))
        extra = _clean(sub.get_text(" ", strip=True)) if sub else ""
        if "user-tie" in classes or (not classes and not p.designation):
            p.designation = p.designation or main
            if extra:
                p.department = p.department or extra.lstrip("|").strip()
        elif "building" in classes:
            p.institute = p.institute or main
            if extra:
                p.years = extra.strip("() ")
        elif "location" in classes:
            p.state = p.state or main

    p.expertise = "; ".join(_clean(b.get_text(" ", strip=True)) for b in soup.select(".custom_hero_exp_badge") if _clean(b.get_text()))

    for badge in soup.select("a.custom_id_badge[href]"):
        href = str(badge["href"])
        if "orcid.org" in href:
            m = ORCID_RE.search(href)
            p.orcid = m.group(0) if m else p.orcid
        elif "scopus.com" in href:
            m = re.search(r"authorId=(\d+)", href)
            p.scopus_id = m.group(1) if m else p.scopus_id
        elif "scholar.google" in href:
            m = re.search(r"user=([\w-]+)", href)
            p.scholar_id = m.group(1) if m else p.scholar_id

    # Text-based fallbacks for a redesigned page.
    text = _clean(soup.get_text(" ", strip=True))
    if not p.orcid:
        m = ORCID_RE.search(text)
        p.orcid = m.group(0) if m else ""
    if not p.expertise:
        m = re.search(r"Expertise:\s*(.+?)(?:\s+View older version|\s+My Dashboard|$)", text)
        p.expertise = _clean(m.group(1))[:300] if m else ""
    for a in soup.find_all("a", href=True):
        href = str(a["href"])
        if re.search(r"^https?://", href) and not re.search(r"inflibnet|irins|scopus|orcid|scholar\.google|google\.com|facebook|twitter|linkedin", href):
            label = _clean(a.get_text(" ", strip=True)).lower()
            if "website" in label or "homepage" in label:
                p.website = href
                break

    p.profile_text = text[:6000]
    return p


class VidwanClient:
    """One cookie-holding session for a search and its profile fetches."""

    def __init__(self, timeout_sec: int | None = None, base_url: str = BASE_URL) -> None:
        self.base_url = base_url.rstrip("/")
        # Pacing: at most `vidwan_concurrency` requests in flight, and request
        # STARTS at least `vidwan_delay_ms` apart, whatever the concurrency.
        self._slots = asyncio.Semaphore(max(1, settings.vidwan_concurrency))
        self._start_lock = asyncio.Lock()
        self._last_start = 0.0
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
        async with self._slots:
            async with self._start_lock:
                gap = settings.vidwan_delay_ms / 1000.0
                wait = self._last_start + gap - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                self._last_start = time.monotonic()
            self.requests += 1
            response = await self._client.request(method, url, **kwargs)
        if response.status_code in (403, 429):
            raise VidwanBlocked(f"HTTP {response.status_code} from {urlparse(url).netloc}")
        response.raise_for_status()
        return response

    async def profiles(self, listings: list[VidwanListing]) -> list[VidwanProfile | BaseException]:
        """Several profiles at once, paced by the client; exceptions are returned in place."""
        return await asyncio.gather(*(self.profile(l) for l in listings), return_exceptions=True)

    async def search(self, query: str, *, max_pages: int = 50, on_page=None) -> tuple[list[VidwanListing], int, int | None]:
        """Every listing card for one query: (listings, pages fetched, total the site reports)."""
        profiles_url = f"{self.base_url}/profiles"
        landing = await self._request("GET", profiles_url)
        token = _csrf_token(BeautifulSoup(landing.text, "lxml"))
        if not token:
            raise RuntimeError("Vidwan search page has no CSRF token — the site layout has changed")

        first = await self._request(
            "POST",
            f"{self.base_url}/profiles/apply-filters",
            data={"_token": token, "q": query, "sortfield": "first_name", "limits": str(PAGE_SIZE)},
            headers={"Referer": profiles_url, "Origin": self.base_url},
        )
        total = parse_total(first.text)
        listings: list[VidwanListing] = []
        seen: set[str] = set()

        def absorb(html: str) -> int:
            new = 0
            for item in parse_listing(html, self.base_url):
                if item.vidwan_id not in seen:
                    seen.add(item.vidwan_id)
                    listings.append(item)
                    new += 1
            return new

        pages = 1
        absorb(first.text)
        if on_page:
            on_page(pages, len(listings), total)
        last_page = math.ceil(total / PAGE_SIZE) if total else max_pages
        # 1-indexed within the session: page 1 is what the POST returned.
        for n in range(2, min(last_page, max_pages) + 1):
            page = await self._request("GET", f"{profiles_url}?page={n}")
            pages += 1
            new = absorb(page.text)
            if on_page:
                on_page(pages, len(listings), total)
            # Nothing new means the session filter is gone (the site would now
            # be serving the unfiltered national list) — stop rather than crawl it.
            if new == 0:
                break
        return listings, pages, total

    async def profile(self, listing: VidwanListing) -> VidwanProfile:
        response = await self._request("GET", listing.profile_url)
        p = parse_profile(response.text, listing.vidwan_id, listing.profile_url)
        # The card is authoritative for what the profile page did not state.
        p.name = p.name or listing.listing_name
        p.designation = p.designation or listing.designation
        p.institute = p.institute or listing.institute
        return p


def looks_like_student(designation: str) -> bool:
    return bool(designation) and bool(STUDENT_ROLE_RE.search(designation))
