"""Reads an open-access paper and returns the part that names instruments.

OpenAlex indexes the full text of only some works. For the rest, the paper is
often still openly readable — the publisher's HTML, a PMC copy, an arXiv or
repository PDF — and OpenAlex tells us where (Node resolves that with a free
single-record lookup and passes the URL here). This module fetches it and
returns the Materials & Methods / Experimental section, which is where an
instrument is named ("performed on a CHI 660E electrochemical workstation").

Only URLs OpenAlex marks as open access are ever requested. Robots.txt and the
per-domain delay apply as they do to every fetch from this service.
"""

import io
import re

import httpx

from ..core.config import settings
from ..core.robots import robots_gate
from ..core.schemas import ScrapeErrorReason
from .enrichment import html_to_text
from .static_fetcher import FetchError

_METHODS_HEADINGS = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:materials?\s+and\s+methods?|experimental(?:\s+(?:section|details|methods?|procedures?))?|"
    r"methods?(?:\s+and\s+materials?)?|methodology|instrumentation|apparatus|electrochemical\s+measurements?|"
    r"characteri[sz]ation|measurements?)\s*:?\s*$",
    re.IGNORECASE | re.MULTILINE,
)

_STOP_HEADINGS = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:results(?:\s+and\s+discussion)?|discussion|conclusions?|acknowledg(?:e)?ments?|references|bibliography)\s*:?\s*$",
    re.IGNORECASE | re.MULTILINE,
)

MAX_PDF_BYTES = 25 * 1024 * 1024
MAX_TEXT_CHARS = 60_000


async def fetch_paper(url: str, timeout_sec: int | None = None) -> tuple[str, str]:
    """Fetches an open-access paper; returns (text, kind) where kind is "pdf" or "html"."""
    if not await robots_gate.can_fetch(url):
        raise FetchError(ScrapeErrorReason.ROBOTS_DISALLOWED, f"robots.txt disallows {url}")
    await robots_gate.wait_for_turn(url)

    try:
        async with httpx.AsyncClient(
            timeout=timeout_sec or settings.scraper_timeout_sec,
            follow_redirects=True,
            headers={
                "User-Agent": settings.scraper_user_agent,
                "Accept": "application/pdf,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            },
        ) as client:
            response = await client.get(url)
    except httpx.TimeoutException as exc:
        raise FetchError(ScrapeErrorReason.TIMEOUT, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise FetchError(ScrapeErrorReason.HTTP_ERROR, str(exc)) from exc

    if response.status_code == 403:
        raise FetchError(ScrapeErrorReason.BLOCKED, "HTTP 403 — publisher refused our crawler")
    if response.status_code >= 400:
        raise FetchError(ScrapeErrorReason.HTTP_ERROR, f"HTTP {response.status_code}")

    content_type = response.headers.get("content-type", "").lower()
    body = response.content
    is_pdf = "pdf" in content_type or body[:5] == b"%PDF-"

    if is_pdf:
        if len(body) > MAX_PDF_BYTES:
            raise FetchError(ScrapeErrorReason.PARSE_ERROR, f"PDF too large ({len(body) // 1024} KB)")
        return pdf_to_text(body), "pdf"

    text = html_to_text(response.text)
    lowered = text[:4000].lower()
    if "access denied" in lowered or "purchase access" in lowered or "sign in to view" in lowered:
        raise FetchError(ScrapeErrorReason.LOGIN_REQUIRED, "paper is paywalled at this location")
    return text, "html"


def pdf_to_text(data: bytes) -> str:
    """Plain text of a PDF, page by page. Layout is lost; sentences survive."""
    from pypdf import PdfReader  # Imported lazily: a heavy module for a rare path.

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 - any malformed file is a parse error
        raise FetchError(ScrapeErrorReason.PARSE_ERROR, f"unreadable PDF: {type(exc).__name__}") from exc

    parts: list[str] = []
    total = 0
    for page in reader.pages:
        try:
            chunk = page.extract_text() or ""
        except Exception:  # noqa: BLE001 - one bad page should not lose the rest
            continue
        parts.append(chunk)
        total += len(chunk)
        if total > MAX_TEXT_CHARS:
            break
    text = "\n".join(parts)
    # PDF extraction hyphenates at line ends and breaks lines mid-sentence.
    text = re.sub(r"-\n(?=[a-z])", "", text)
    return re.sub(r"[ \t]+", " ", text)


def methods_section(text: str, *, max_chars: int = 12_000) -> str:
    """The experimental section if one can be found, else the whole (trimmed) text.

    Falling back to the full text is deliberate: an instrument named in a
    figure caption or the supplementary note still counts.
    """
    if not text:
        return ""
    # A paper can carry the heading twice — once in a table of contents, once
    # where the section actually starts — so every occurrence is considered and
    # the one introducing the most text wins. Short communications have short
    # methods sections; a length floor would throw those away.
    best = ""
    for m in _METHODS_HEADINGS.finditer(text):
        stop = _STOP_HEADINGS.search(text, m.end())
        end = stop.start() if stop and stop.start() > m.start() else len(text)
        section = text[m.start():end]
        if len(section) > len(best):
            best = section
    if len(best.strip()) < 80:
        return text[:max_chars]
    return best[:max_chars]
