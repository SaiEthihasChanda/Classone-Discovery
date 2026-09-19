"""Finds faculty-directory URLs for an institution automatically.

WHY THIS EXISTS: the biggest limit on scraped coverage was never bot-blocking —
it was that faculty-page URLs were hand-guessed, and most guesses 404. Crawling
an institution's own site for directory links replaces guesswork with something
systematic, and needs no evasion of any kind: it follows published links, honours
robots.txt, and identifies itself.

Deliberately shallow (homepage -> department links -> directory links). Faculty
directories are almost always within two hops of the homepage, and going deeper
costs rate-limited fetches for rapidly diminishing returns.
"""

import asyncio
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from ..core.schemas import ExtractedPerson
from .faculty_scraper import parse_faculty_page
from .static_fetcher import FetchError, fetch_page

# Link text or URL fragments that suggest a people listing.
DIRECTORY_HINTS = (
    "faculty",
    "people",
    "staff",
    "directory",
    "our-team",
    "academics",
    "professors",
)

# Departments whose faculty plausibly buy electrochemical instrumentation.
# Used to rank candidates so the most relevant pages are probed first.
RELEVANT_DEPT_HINTS = (
    "chem",
    "material",
    "metallurg",
    "physic",
    "energy",
    "nano",
    "bio",
    "environment",
    "civil",
    "mechanical",
    "electrical",
)

SKIP_PATTERNS = re.compile(
    r"(login|signin|apply|admission|alumni|tender|notice|news|event|gallery|"
    r"download|contact|privacy|sitemap|search|\.pdf$|\.doc|\.zip|mailto:|tel:)",
    re.I,
)


def _score_candidate(url: str, link_text: str) -> int:
    """Higher means more likely to be a useful faculty directory."""
    haystack = f"{url} {link_text}".lower()
    score = 0

    if any(h in haystack for h in DIRECTORY_HINTS):
        score += 10
    # "faculty" is a stronger signal than "people".
    if "faculty" in haystack:
        score += 5
    if any(h in haystack for h in RELEVANT_DEPT_HINTS):
        score += 8
    # Prefer index pages over individual profiles.
    if re.search(r"/(faculty|people|staff)/?$", url, re.I):
        score += 6
    # Deep paths are usually individual profiles.
    depth = urlparse(url).path.count("/")
    score -= max(0, depth - 4)

    return score


def extract_candidate_links(html: str, base_url: str, same_host_only: bool = True) -> list[tuple[str, int]]:
    """Returns (url, score) for links that might lead to a faculty listing."""
    soup = BeautifulSoup(html, "lxml")
    base_host = urlparse(base_url).netloc
    seen: dict[str, int] = {}

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if not isinstance(href, str) or SKIP_PATTERNS.search(href):
            continue

        absolute = urljoin(base_url, href).split("#")[0].rstrip("/") or base_url
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue

        # Allow department subdomains (chem.iitb.ac.in under iitb.ac.in), which is
        # where most Indian institutes actually put their directories.
        if same_host_only:
            root = ".".join(base_host.split(".")[-3:])
            if not parsed.netloc.endswith(root):
                continue

        text = " ".join(anchor.get_text(" ", strip=True).split())[:80]
        score = _score_candidate(absolute, text)
        if score > 0:
            seen[absolute] = max(seen.get(absolute, 0), score)

    return sorted(seen.items(), key=lambda kv: -kv[1])


async def find_faculty_pages(
    root_url: str,
    max_probes: int = 8,
    timeout_sec: int = 20,
) -> list[dict]:
    """Crawls an institution site shallowly and returns pages that parse as directories.

    Each result is {url, people, emails, profiles}. Only pages yielding at least
    three extractable people are returned — below that it is almost always
    navigation noise rather than a directory.
    """
    results: list[dict] = []

    try:
        homepage = await fetch_page(root_url, timeout_sec)
    except FetchError as exc:
        return [{"url": root_url, "error": exc.reason.value, "detail": exc.detail}]

    candidates = extract_candidate_links(homepage, root_url)

    # The homepage itself occasionally IS the directory.
    to_probe = [(root_url, 100)] + candidates[: max_probes * 3]

    probed = 0
    seen_urls: set[str] = set()

    for url, _score in to_probe:
        if probed >= max_probes:
            break
        if url in seen_urls:
            continue
        seen_urls.add(url)

        try:
            html = await fetch_page(url, timeout_sec)
        except FetchError:
            continue
        except Exception:  # noqa: BLE001 - one bad page must not stop the crawl
            continue

        probed += 1

        try:
            people: list[ExtractedPerson] = parse_faculty_page(html, url)
        except Exception:  # noqa: BLE001
            continue

        if len(people) >= 3:
            results.append(
                {
                    "url": url,
                    "people": len(people),
                    "emails": sum(1 for p in people if p.email),
                    "profiles": sum(1 for p in people if p.profile_url),
                    "sample": [p.name for p in people[:3]],
                }
            )

    return sorted(results, key=lambda r: -r.get("people", 0))


async def find_for_many(roots: list[tuple[str, str]], max_probes: int = 6) -> dict[str, list[dict]]:
    """Runs `find_faculty_pages` for several institutions.

    Institutions run concurrently; the per-domain rate limiter still serialises
    requests within each one.
    """
    async def one(name: str, url: str):
        return name, await find_faculty_pages(url, max_probes=max_probes)

    pairs = await asyncio.gather(*(one(n, u) for n, u in roots))
    return dict(pairs)


# ---------------------------------------------------------------------------
# Two-hop discovery: homepage -> department pages -> faculty listings
# ---------------------------------------------------------------------------


def _links_with_text(html: str, base_url: str) -> list[tuple[str, str]]:
    """Every same-site link on a page as (absolute url, link text)."""
    soup = BeautifulSoup(html, "lxml")
    base_host = urlparse(base_url).netloc
    root = ".".join(base_host.split(".")[-3:])
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if not isinstance(href, str) or SKIP_PATTERNS.search(href):
            continue
        absolute = urljoin(base_url, href).split("#")[0].rstrip("/")
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https") or not parsed.netloc.endswith(root):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        text = " ".join(anchor.get_text(" ", strip=True).split())[:80]
        out.append((absolute, text))
    return out


# Where Indian institutes conventionally put a department: a subdomain or a
# path with a short code. Homepages are increasingly JavaScript menus that
# expose no department links to a static fetch (IIT Bombay's exposes none even
# when rendered), so these are probed directly. Each maps to the department
# hint it stands for; a 404 costs one cheap request.
DEPARTMENT_CODES: list[tuple[str, str]] = [
    ("chem", "chemistry"),
    ("chemistry", "chemistry"),
    ("che", "chemical"),
    ("chemical", "chemical"),
    ("cheme", "chemical"),
    ("bsbe", "bioscience"),
    ("bio", "biolog"),
    ("biotech", "biotech"),
    ("bt", "biotech"),
    ("dbeb", "biochem"),
    ("bioscience", "bioscience"),
    ("biosciences", "bioscience"),
    ("biology", "biolog"),
    ("mems", "metallurg"),
    ("mme", "metallurg"),
    ("mm", "metallurg"),
    ("meta", "metallurg"),
    ("metallurgy", "metallurg"),
    ("mat", "material"),
    ("materials", "material"),
    ("mse", "material"),
    ("ese", "energy"),
    ("energy", "energy"),
    ("dese", "energy"),
    ("civil", "civil"),
    ("ce", "civil"),
    ("me", "mechanical"),
    ("mech", "mechanical"),
    ("mechanical", "mechanical"),
]

# Link text/URL fragments that lead to a list of departments.
DEPARTMENT_INDEX_HINTS = ("department", "academic-unit", "academics/dept", "schools", "centres", "centers")


def _seed_candidates(root_url: str, dept_hints: list[str]) -> list[tuple[str, str, str]]:
    """Conventional department URLs for an institute: (url, text, hint)."""
    parsed = urlparse(root_url)
    host = parsed.netloc
    bare = host[4:] if host.startswith("www.") else host
    wanted = {h.lower() for h in dept_hints}
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for code, hint in DEPARTMENT_CODES:
        if hint not in wanted:
            continue
        # IIT Bombay's departments answer only on the www. form (the bare host
        # does not resolve); others only on the bare form. Both are tried.
        for url in (f"{parsed.scheme}://www.{code}.{bare}", f"{parsed.scheme}://{code}.{bare}", f"{root_url.rstrip('/')}/{code}"):
            if url in seen:
                continue
            seen.add(url)
            out.append((url, f"{code} department", hint))
    return out


def _department_guess(url: str, text: str, dept_hints: list[str]) -> str | None:
    hay = f"{url} {text}".lower()
    for hint in dept_hints:
        if hint.lower() in hay:
            return hint
    return None


async def find_department_faculty_pages(
    root_url: str,
    dept_hints: list[str],
    max_probes: int = 30,
    timeout_sec: int = 20,
) -> list[dict]:
    """Finds the faculty listings of the departments named by `dept_hints`.

    Indian institute sites almost never link a faculty list from the homepage;
    the path is homepage -> "Departments" / a department's own subdomain ->
    "Faculty". So this goes two hops: department-looking links from the
    homepage are fetched, and directory-looking links on THOSE pages are
    probed. Pages that parse as a listing of at least three people are
    returned with the department they were reached through.

    Same rules as everything else here: robots.txt, an honest User-Agent,
    the per-domain delay, and a hard cap on fetches per institute.
    """
    results: list[dict] = []
    # The homepage is one source of links, not a prerequisite: the conventional
    # department hosts are probed regardless, so a slow or blocked homepage
    # only loses the links it would have contributed.
    homepage = ""
    try:
        homepage = await fetch_page(root_url, timeout_sec)
    except FetchError as exc:
        if exc.reason.value == "robots_disallowed":
            return [{"url": root_url, "error": exc.reason.value, "detail": exc.detail}]
    except Exception:  # noqa: BLE001
        pass

    def rank(url: str, text: str, hop: int) -> int:
        score = _score_candidate(url, text)
        if _department_guess(url, text, dept_hints):
            score += 20
        # A second-hop link that says "faculty" outranks a first-hop one that
        # merely names a department.
        if hop == 2 and any(h in f"{url} {text}".lower() for h in ("faculty", "people", "staff")):
            score += 15
        return score

    queue: list[tuple[int, str, str, int, str | None]] = []  # (-score, url, text, hop, dept)
    queued_urls: set[str] = set()

    def enqueue(url: str, text: str, hop: int, dept: str | None, bonus: int = 0) -> None:
        if url in queued_urls:
            return
        score = rank(url, text, hop) + bonus
        if score > 0 or dept:
            queued_urls.add(url)
            queue.append((-score, url, text, hop, dept))

    home_links = _links_with_text(homepage, root_url) if homepage else []
    for url, text in home_links:
        enqueue(url, text, 1, _department_guess(url, text, dept_hints))

    # A "Departments" index page, when the homepage has one, lists every
    # department in plain HTML even when the menu itself is script-driven.
    index_pages = [
        (url, text) for url, text in home_links if any(h in f"{url} {text}".lower() for h in DEPARTMENT_INDEX_HINTS)
    ][:3]
    for url, text in index_pages:
        try:
            index_html = await fetch_page(url, timeout_sec)
        except Exception:  # noqa: BLE001
            continue
        for sub_url, sub_text in _links_with_text(index_html, url):
            dept = _department_guess(sub_url, sub_text, dept_hints)
            if dept:
                enqueue(sub_url, sub_text, 1, dept)

    # Conventional department hosts and paths, whether or not anything links
    # to them. Ranked below real links so a linked page is tried first, and
    # fetched with a short timeout: a guessed host that hangs is not worth
    # the full wait a linked page gets.
    seed_urls: set[str] = set()
    for url, text, hint in _seed_candidates(root_url, dept_hints):
        seed_urls.add(url)
        enqueue(url, text, 1, hint, bonus=-5)
    queue.sort()
    seed_timeout = min(timeout_sec, 10)

    probed: set[str] = set([root_url.rstrip("/")])
    fetched = 0
    attempts = 0
    found_urls: set[str] = set()

    # Failed fetches (a 404 on a guessed host) do not use up the probe budget,
    # but they take time, so the total number of attempts is capped too.
    while queue and fetched < max_probes and attempts < max_probes * 4:
        _neg, url, text, hop, dept = queue.pop(0)
        if url in probed:
            continue
        probed.add(url)
        attempts += 1

        try:
            html = await fetch_page(url, seed_timeout if url in seed_urls else timeout_sec)
        except FetchError as exc:
            # A linked page (not a guessed host) that timed out gets one more
            # try: institute servers are slow in bursts, and a listing missed
            # today is a department missing from the roster.
            if url in seed_urls or exc.reason.value != "timeout":
                continue
            try:
                await asyncio.sleep(2)
                html = await fetch_page(url, timeout_sec)
            except Exception:  # noqa: BLE001
                continue
        except Exception:  # noqa: BLE001 - one bad page must not stop the crawl
            continue
        fetched += 1

        try:
            people: list[ExtractedPerson] = parse_faculty_page(html, url)
        except Exception:  # noqa: BLE001
            people = []

        if len(people) >= 3 and url not in found_urls:
            found_urls.add(url)
            results.append(
                {
                    "url": url,
                    "department": dept or _department_guess(url, text, dept_hints),
                    "people": len(people),
                    "emails": sum(1 for p in people if p.email),
                    "profiles": sum(1 for p in people if p.profile_url),
                    "sample": [p.name for p in people[:3]],
                    "hop": hop,
                    # The link text that led here ("Faculty") — the URL alone
                    # ("/people") does not always say what the page lists.
                    "label": text[:80],
                }
            )
            continue

        # Not a listing — but if it is a department page, its own links are
        # where the listing will be.
        this_dept = dept or _department_guess(url, text, dept_hints)
        if hop == 1 and this_dept:
            for sub_url, sub_text in _links_with_text(html, url):
                if sub_url in probed:
                    continue
                hay = f"{sub_url} {sub_text}".lower()
                if any(h in hay for h in DIRECTORY_HINTS):
                    enqueue(sub_url, sub_text, 2, this_dept)
            queue.sort()

    return sorted(results, key=lambda r: -r.get("people", 0))
