"""University news extraction.

RSS/Atom first, HTML only as a fallback. Feeds are structured, stable, explicitly
published for machine consumption, and cheaper to fetch — so when a site offers
one, using it is both more polite and more reliable than parsing their markup.
"""

import re
from datetime import datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..core.schemas import ExtractedNewsItem

# Common feed locations to probe when a target is given as a plain page URL.
FEED_PATHS = ("/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/news/rss.xml")

# "Prof. Jane Smith" / "Dr Ada Lovelace" — titled names in article text are the
# reliable signal. Bare capitalised pairs match far too much prose to be useful.
#
# The optional third token captures double surnames ("Maria Garcia Lopez"), which
# a two-token pattern silently truncates. Capitalised connectives are excluded so
# a following clause ("Dr. Jane Smith And Colleagues") is not swallowed.
_NAME_TOKEN = r"[A-ZÀ-ɏ][A-Za-zÀ-ɏ'’-]+"
_NOT_A_NAME_TOKEN = r"(?!And\b|Or\b|The\b|A\b|An\b|At\b|In\b|Of\b|For\b|With\b)"

TITLED_NAME_RE = re.compile(
    r"\b(?:Professor|Prof\.?|Dr\.?)\s+"
    rf"({_NAME_TOKEN}"
    r"(?:\s+[A-Z]\.?)?"                       # optional middle initial
    rf"\s+{_NOT_A_NAME_TOKEN}{_NAME_TOKEN}"   # surname
    rf"(?:\s+{_NOT_A_NAME_TOKEN}{_NAME_TOKEN})?"  # optional second surname
    r")"
)


def looks_like_feed(text: str) -> bool:
    head = text[:1000].lower()
    return "<rss" in head or "<feed" in head or "<rdf:rdf" in head


def candidate_feed_urls(page_url: str) -> list[str]:
    """Feed URLs worth probing for a given news page."""
    return [urljoin(page_url, path) for path in FEED_PATHS]


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    # RFC 822 (RSS)
    try:
        return parsedate_to_datetime(value)
    except (TypeError, ValueError):
        pass
    # ISO 8601 (Atom)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def extract_mentioned_names(text: str) -> list[str]:
    """Pulls titled researcher names out of article text.

    Node cross-references these against known leads, so a news item about an
    existing prospect becomes an engagement signal rather than a new record.
    """
    seen: list[str] = []
    for match in TITLED_NAME_RE.finditer(text):
        name = " ".join(match.group(1).split())
        if name not in seen:
            seen.append(name)
    return seen[:10]


def parse_feed(xml: str, limit: int = 30) -> list[ExtractedNewsItem]:
    soup = BeautifulSoup(xml, "xml")
    items: list[ExtractedNewsItem] = []

    # RSS uses <item>, Atom uses <entry>.
    for node in soup.find_all(["item", "entry"])[:limit]:
        title_node = node.find("title")
        if not title_node:
            continue
        title = " ".join(title_node.get_text(" ", strip=True).split())
        if not title:
            continue

        link_node = node.find("link")
        link = None
        if link_node:
            # Atom puts the URL in an href attribute; RSS puts it in the text.
            link = link_node.get("href") or link_node.get_text(strip=True) or None

        summary_node = node.find("description") or node.find("summary") or node.find("content")
        summary = (
            " ".join(summary_node.get_text(" ", strip=True).split())[:800]
            if summary_node
            else None
        )

        date_node = node.find("pubDate") or node.find("published") or node.find("updated")
        published = _parse_date(date_node.get_text(strip=True) if date_node else None)

        items.append(
            ExtractedNewsItem(
                title=title,
                url=link,
                published_at=published,
                summary=summary,
                mentioned_names=extract_mentioned_names(f"{title}. {summary or ''}"),
            )
        )

    return items


def parse_news_html(html: str, source_url: str, limit: int = 30) -> list[ExtractedNewsItem]:
    """Fallback for news pages with no feed."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.find_all(["nav", "header", "footer", "script", "style"]):
        tag.decompose()

    items: list[ExtractedNewsItem] = []
    seen: set[str] = set()

    for heading in soup.find_all(["h2", "h3"])[: limit * 3]:
        title = " ".join(heading.get_text(" ", strip=True).split())
        if not (15 <= len(title) <= 200) or title.lower() in seen:
            continue
        seen.add(title.lower())

        anchor = heading.find("a", href=True) or heading.find_parent("a", href=True)
        url = urljoin(source_url, anchor["href"]) if anchor else None

        # Nearby paragraph text is the usual article teaser.
        context = heading.find_parent(["article", "li", "div"])
        summary = None
        if context:
            paragraph = context.find("p")
            if paragraph:
                summary = " ".join(paragraph.get_text(" ", strip=True).split())[:800]

        items.append(
            ExtractedNewsItem(
                title=title,
                url=url,
                published_at=None,
                summary=summary,
                mentioned_names=extract_mentioned_names(f"{title}. {summary or ''}"),
            )
        )

        if len(items) >= limit:
            break

    return items
