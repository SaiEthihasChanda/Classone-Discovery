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
