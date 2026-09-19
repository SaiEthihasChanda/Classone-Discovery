"""Tiered fetching: cheap first, expensive only when it would help.

  Tier 1  static HTTP GET          — fast, low memory, works for most sites
  Tier 2  real browser (Playwright) — for client-side-rendered pages and the few
                                      WAFs that check TLS fingerprints
  Tier 3  browser via proxy         — same, from a different egress IP, for
                                      IP-reputation blocks (needs credentials)

Escalation is driven by OUTCOME, not by guesswork: a page that returns 200 but
yields nothing useful is escalated just like an outright block, because a
JS-rendered directory looks exactly like an empty one over plain HTTP.

Tiers 2 and 3 only run when explicitly enabled, so the default path stays cheap.
"""

from dataclasses import dataclass
from typing import Callable

from ..core.config import settings
from ..core.schemas import ScrapeErrorReason
from .dynamic_fetcher import fetch_page_dynamic
from .static_fetcher import FetchError, fetch_page

# Escalating past these is pointless: the answer will not change with a different
# renderer or a different IP.
_TERMINAL_REASONS = {
    ScrapeErrorReason.ROBOTS_DISALLOWED,  # a policy decision, not a technical block
    ScrapeErrorReason.LOGIN_REQUIRED,
}


@dataclass
class FetchOutcome:
    html: str
    tier: str  # "static" | "browser" | "browser+proxy"


async def fetch_with_escalation(
    url: str,
    timeout_sec: int | None = None,
    *,
    allow_browser: bool = True,
    allow_proxy: bool = True,
    is_sufficient: Callable[[str], bool] | None = None,
) -> FetchOutcome:
    """Fetches `url`, escalating tiers until the result is usable.

    `is_sufficient` decides whether a 200 response actually contained what we
    wanted — for a faculty page that means "did we extract any people". Without
    it, only hard failures trigger escalation.
    """
    last_error: FetchError | None = None

    # --- Tier 1: static -----------------------------------------------------
    try:
        html = await fetch_page(url, timeout_sec)
        if is_sufficient is None or is_sufficient(html):
            return FetchOutcome(html=html, tier="static")
        # 200 but empty — very likely client-side rendered, so a browser is worth trying.
    except FetchError as exc:
        if exc.reason in _TERMINAL_REASONS:
            raise
        last_error = exc

    browser_enabled = allow_browser and settings.scraper_enable_browser
    if not browser_enabled:
        if last_error:
            raise last_error
        # Static succeeded but produced nothing usable, and escalation is off.
        return FetchOutcome(html=html, tier="static")

    # --- Tier 2: real browser ----------------------------------------------
    try:
        rendered = await fetch_page_dynamic(url, timeout_sec)
        if is_sufficient is None or is_sufficient(rendered):
            return FetchOutcome(html=rendered, tier="browser")
        last_error = FetchError(
            ScrapeErrorReason.PARSE_ERROR,
            "page rendered but no records could be extracted",
        )
    except FetchError as exc:
        if exc.reason in _TERMINAL_REASONS:
            raise
        last_error = exc

    # --- Tier 3: browser via proxy -----------------------------------------
    # Only meaningful for IP-reputation blocks, and only if a proxy is configured.
    proxy_available = bool(settings.scraper_proxy_url)
    should_try_proxy = (
        allow_proxy
        and proxy_available
        and last_error is not None
        and last_error.reason in (ScrapeErrorReason.BLOCKED, ScrapeErrorReason.HTTP_ERROR)
    )

    if should_try_proxy:
        # The shared browser already carries the proxy when one is configured, so
        # tier 3 differs from tier 2 only when the browser was launched without
        # one. Kept as an explicit tier so the distinction stays visible in
        # results and so a per-request proxy can be slotted in later.
        try:
            rendered = await fetch_page_dynamic(url, timeout_sec)
            if is_sufficient is None or is_sufficient(rendered):
                return FetchOutcome(html=rendered, tier="browser+proxy")
        except FetchError as exc:
            last_error = exc

    raise last_error or FetchError(
        ScrapeErrorReason.UNKNOWN, "all fetch tiers exhausted without a usable result"
    )
