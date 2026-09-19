"""HTTP fetching for static pages.

Every fetch in this service goes through `fetch_page`, which enforces the
robots.txt gate and the per-domain rate limit before a request is made. There is
no other way to fetch — that is the point.
"""

import httpx

from ..core.config import settings
from ..core.robots import robots_gate
from ..core.schemas import ScrapeErrorReason


class FetchError(Exception):
    """A fetch that failed for a reason worth reporting back to Node."""

    def __init__(self, reason: ScrapeErrorReason, detail: str = "") -> None:
        super().__init__(detail or reason.value)
        self.reason = reason
        self.detail = detail


# Pages behind these are not worth fetching and must never be worked around.
_LOGIN_MARKERS = (
    "please sign in",
    "please log in",
    "login required",
    "authentication required",
)


async def fetch_page(url: str, timeout_sec: int | None = None) -> str:
    """Fetches a page as text, or raises FetchError.

    Order matters: robots.txt is checked BEFORE the rate-limit wait, so a
    disallowed URL costs nothing.
    """
    if not await robots_gate.can_fetch(url):
        raise FetchError(
            ScrapeErrorReason.ROBOTS_DISALLOWED,
            f"robots.txt disallows {url} for our user agent",
        )

    await robots_gate.wait_for_turn(url)

    try:
        async with httpx.AsyncClient(
            timeout=timeout_sec or settings.scraper_timeout_sec,
            follow_redirects=True,
            headers={
                "User-Agent": settings.scraper_user_agent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        ) as client:
            response = await client.get(url)
    except httpx.TimeoutException as exc:
        raise FetchError(ScrapeErrorReason.TIMEOUT, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise FetchError(ScrapeErrorReason.HTTP_ERROR, str(exc)) from exc

    if response.status_code == 401:
        raise FetchError(
            ScrapeErrorReason.LOGIN_REQUIRED,
            "HTTP 401 — page requires authentication, skipping",
        )
    if response.status_code == 403:
        # Usually a WAF or bot-detection layer refusing our declared User-Agent
        # rather than a genuine permission problem. We do NOT retry disguised as
        # a browser — evading bot detection is exactly the line this service does
        # not cross. Report it so the target can be dropped from the list.
        raise FetchError(
            ScrapeErrorReason.BLOCKED,
            "HTTP 403 — server refused our identified crawler, skipping",
        )
    if response.status_code >= 400:
        raise FetchError(
            ScrapeErrorReason.HTTP_ERROR,
            f"HTTP {response.status_code}",
        )

    text = response.text
    lowered = text[:4000].lower()
    if any(marker in lowered for marker in _LOGIN_MARKERS):
        raise FetchError(
            ScrapeErrorReason.LOGIN_REQUIRED,
            "page appears to be behind a login wall, skipping",
        )

    return text
