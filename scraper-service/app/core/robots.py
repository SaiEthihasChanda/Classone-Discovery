"""robots.txt enforcement and per-domain rate limiting.

This is a hard gate, not a suggestion. Every fetch in this service goes through
`RobotsGate.can_fetch()` first, and a disallowed path is never requested.

Built in Phase 1 rather than alongside the scrapers in Phase 2 on purpose: it is
much easier to route every fetch through a gate that already exists than to
retrofit one after scrapers are written.

WHY PROTEGO AND NOT `urllib.robotparser`: the stdlib parser resolves conflicting
rules by first match, while RFC 9309 (the de-facto standard) resolves by longest
match. On a file like::

    User-agent: *
    Disallow: /
    Allow: /faculty/

the stdlib parser reports /faculty/ as disallowed and we would silently skip that
university entirely. Protego implements the spec and correctly allows it. This was
verified against both parsers before choosing.
"""

import asyncio
import time
from urllib.parse import urlparse

import httpx
from protego import Protego

from .config import settings

# robots.txt rarely changes; re-fetching it per request would itself be impolite.
_ROBOTS_CACHE_TTL_SEC = 3600


class RobotsGate:
    """Caches robots.txt per domain and enforces a minimum delay between requests."""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[Protego | None, float]] = {}
        self._last_request_at: dict[str, float] = {}
        # One lock per domain: requests to different domains still run concurrently.
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, domain: str) -> asyncio.Lock:
        if domain not in self._locks:
            self._locks[domain] = asyncio.Lock()
        return self._locks[domain]

    async def _get_parser(self, domain: str, scheme: str) -> Protego | None:
        cached = self._cache.get(domain)
        if cached and (time.monotonic() - cached[1]) < _ROBOTS_CACHE_TTL_SEC:
            return cached[0]

        parser: Protego | None = None
        try:
            async with httpx.AsyncClient(
                timeout=10.0,
                follow_redirects=True,
                headers={"User-Agent": settings.scraper_user_agent},
            ) as client:
                response = await client.get(f"{scheme}://{domain}/robots.txt")

            if response.status_code == 200:
                parser = Protego.parse(response.text)
            # A 404 means no robots.txt, which means no restrictions. Leaving the
            # parser as None is read as "allowed" below.
        except (httpx.HTTPError, ValueError):
            # Unreachable or unparseable robots.txt is treated as "no restrictions
            # stated" rather than blocking the run outright.
            parser = None

        self._cache[domain] = (parser, time.monotonic())
        return parser

    async def can_fetch(self, url: str) -> bool:
        """True if robots.txt permits fetching this URL for our User-Agent."""
        if not settings.scraper_respect_robots:
            return True

        parsed = urlparse(url)
        if not parsed.netloc:
            return False

        parser = await self._get_parser(parsed.netloc, parsed.scheme or "https")
        if parser is None:
            return True

        # Note the argument order: Protego is (url, user_agent), the reverse of
        # the stdlib parser's (user_agent, url).
        return bool(parser.can_fetch(url, settings.scraper_user_agent))

    async def _delay_for(self, url: str, domain: str) -> float:
        """Our configured delay, or the site's declared Crawl-delay if it asks for more."""
        delay_sec = settings.scraper_request_delay_ms / 1000.0

        if not settings.scraper_respect_robots:
            return delay_sec

        parser = await self._get_parser(domain, urlparse(url).scheme or "https")
        if parser is None:
            return delay_sec

        declared = parser.crawl_delay(settings.scraper_user_agent)
        # Only ever slow down, never speed up below our own floor.
        return max(delay_sec, float(declared)) if declared else delay_sec

    async def wait_for_turn(self, url: str) -> None:
        """Blocks until the politeness delay for this URL's domain has elapsed."""
        domain = urlparse(url).netloc
        if not domain:
            return

        delay_sec = await self._delay_for(url, domain)

        # Held across the sleep so two concurrent requests to the same domain
        # queue up rather than both reading the same stale timestamp and firing
        # together.
        async with self._lock_for(domain):
            last = self._last_request_at.get(domain)
            if last is not None:
                elapsed = time.monotonic() - last
                if elapsed < delay_sec:
                    await asyncio.sleep(delay_sec - elapsed)
            self._last_request_at[domain] = time.monotonic()


robots_gate = RobotsGate()
