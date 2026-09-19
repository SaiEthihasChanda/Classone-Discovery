"""Researcher registries: where is this person, according to a profile database?

For Indian institutes two public, government-run registries answer this better
than any bibliographic source:

  - IRINS (Indian Research Information Network System, INFLIBNET) — institute-
    maintained profiles of CURRENT faculty.
  - Vidwan (vidwan.inflibnet.ac.in) — the national expert database, one
    self-maintained profile per researcher with a current affiliation.

Both are searched by name. The parser is deliberately generic — a search page
yields profile links whose anchor text looks like the person; a profile page
is read for labelled fields ("Affiliation", "Institute", "Designation",
"Department") and, failing labels, for any known institute name in the text —
so a template change on either site degrades to "nothing found" rather than to
wrong data. Node decides what a hit means; this module only reports it.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import quote_plus, urljoin, urlparse

from bs4 import BeautifulSoup

from .enrichment import name_matches
from .static_fetcher import fetch_page

_AFFILIATION_LABELS = re.compile(
    r"^(?:current\s+)?(?:affiliation|institute|institution|organi[sz]ation|university|employer|works?\s+at)\s*:?\s*$",
    re.IGNORECASE,
)
_DEPARTMENT_LABELS = re.compile(r"^(?:department|dept\.?|school|centre|center)\s*:?\s*$", re.IGNORECASE)
_DESIGNATION_LABELS = re.compile(r"^(?:designation|position|title|role)\s*:?\s*$", re.IGNORECASE)

_NAV_WORDS = ("login", "sign in", "register", "home", "about", "contact", "search", "help", "faq", "privacy")


@dataclass
class RegistryHit:
    source: str
    profile_url: str
    matched_name: str
    institution: str | None = None
    department: str | None = None
    designation: str | None = None
    detail: str | None = None


@dataclass
class RegistryResult:
    source: str
    search_url: str
    hits: list[RegistryHit] = field(default_factory=list)
    error: str | None = None


def profile_links(html: str, base_url: str, name: str, *, limit: int = 3) -> list[tuple[str, str]]:
    """(url, anchor text) for links on a search page that look like this person's profile."""
    soup = BeautifulSoup(html, "lxml")
    base_host = urlparse(base_url).netloc.lower()
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    for anchor in soup.find_all("a", href=True):
        text = " ".join(anchor.get_text(" ", strip=True).split())
        href = anchor["href"]
        if not text or not isinstance(href, str) or href.lower().startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        if text.lower() in _NAV_WORDS or len(text) > 80:
            continue
        # Strip honorifics the registry may prepend before matching.
        candidate = re.sub(r"^(?:dr|prof|professor|mr|mrs|ms)\.?\s+", "", text, flags=re.IGNORECASE)
        if not name_matches(candidate, name):
            continue
        absolute = urljoin(base_url, href).split("#")[0]
        if urlparse(absolute).netloc.lower() != base_host:
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        out.append((absolute, text))
        if len(out) >= limit:
            break
    return out


def _labelled_value(soup: BeautifulSoup, label_re: re.Pattern[str]) -> str | None:
    """The text following a label, in the layouts registries use: dt/dd, th/td, label/value, 'Label: value'."""
    for tag in soup.find_all(["dt", "th", "label", "strong", "b", "span", "div", "td", "p"]):
        text = " ".join(tag.get_text(" ", strip=True).split())
        if not text or len(text) > 40 or not label_re.match(text):
            continue
        # dt → dd, th → td, label → next sibling element
        nxt = tag.find_next_sibling()
        if nxt is not None:
            value = " ".join(nxt.get_text(" ", strip=True).split())
            if value and value.rstrip(":") != text.rstrip(":") and len(value) < 200:
                return value
        # "Label: value" inside the same element's parent
        parent = tag.parent
        if parent is not None:
            ptext = " ".join(parent.get_text(" ", strip=True).split())
            m = re.match(rf"^{re.escape(text)}\s*:?\s*(.+)$", ptext)
            if m and 0 < len(m.group(1)) < 200:
                return m.group(1).strip()
    return None


def extract_profile_affiliation(html: str, known_institutions: list[str]) -> dict[str, str | None]:
    """Institution, department and designation from a registry profile page."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(("script", "style", "noscript", "nav", "footer")):
        tag.decompose()

    institution = _labelled_value(soup, _AFFILIATION_LABELS)
    department = _labelled_value(soup, _DEPARTMENT_LABELS)
    designation = _labelled_value(soup, _DESIGNATION_LABELS)

    if not institution and known_institutions:
        # Fall back to the first known institute named anywhere prominent on the page.
        head = soup.get_text(" ", strip=True)[:4000].lower()
        for inst in known_institutions:
            if inst.lower() in head:
                institution = inst
                break

    return {"institution": institution, "department": department, "designation": designation}


async def search_registry(
    source: str,
    search_url_template: str,
    name: str,
    known_institutions: list[str],
    *,
    timeout_sec: int | None = None,
    max_profiles: int = 2,
) -> RegistryResult:
    """Searches one registry by name and reads the matching profile(s)."""
    search_url = search_url_template.replace("{name}", quote_plus(name))
    result = RegistryResult(source=source, search_url=search_url)

    try:
        html = await fetch_page(search_url, timeout_sec)
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        result.error = f"{type(exc).__name__}: {exc}"
        return result

    for url, text in profile_links(html, search_url, name, limit=max_profiles):
        try:
            page = await fetch_page(url, timeout_sec)
        except Exception as exc:  # noqa: BLE001
            result.hits.append(RegistryHit(source=source, profile_url=url, matched_name=text, detail=f"profile fetch failed: {exc}"))
            continue
        fields = extract_profile_affiliation(page, known_institutions)
        result.hits.append(
            RegistryHit(
                source=source,
                profile_url=url,
                matched_name=text,
                institution=fields["institution"],
                department=fields["department"],
                designation=fields["designation"],
            )
        )
    return result
