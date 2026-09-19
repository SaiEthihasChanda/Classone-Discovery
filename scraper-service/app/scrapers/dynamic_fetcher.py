"""Real-browser fetching via Playwright, with optional proxy support.

WHEN THIS EARNS ITS KEEP — measured, not assumed:
  - Client-side-rendered directories, where the static HTML contains no people
    (IIT Indore MEMS: 0 people via static fetch, 13 via a browser).
  - A handful of WAFs that reject non-browser TLS fingerprints
    (MIT News: 403 static, 200 in a browser).

WHAT IT DOES NOT FIX: most 403s here are IP-reputation based and survive a real
browser with a real fingerprint. Those need a different egress IP, which is what
the proxy support below is for — supply credentials via env and they are used.

Cost: a browser page load is ~10-30x the time and memory of an HTTP GET, so this
is a FALLBACK tier, never the first attempt. See `tiered_fetcher.py`.

robots.txt is enforced before any navigation, exactly as in the static path — a
real browser does not change what we are permitted to fetch.
"""

import asyncio
from typing import Any

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout
from playwright.async_api import async_playwright

from ..core.config import settings
from ..core.robots import robots_gate
from ..core.schemas import ScrapeErrorReason
from .static_fetcher import FetchError

# One browser process is reused across requests — launching Chromium per fetch
# would dominate the runtime.
_browser: Any = None
_playwright: Any = None
_launch_lock = asyncio.Lock()


def _proxy_config() -> dict[str, str] | None:
    """Playwright proxy settings from env, or None when unconfigured."""
    if not settings.scraper_proxy_url:
        return None

    proxy: dict[str, str] = {"server": settings.scraper_proxy_url}
    if settings.scraper_proxy_username:
        proxy["username"] = settings.scraper_proxy_username
    if settings.scraper_proxy_password:
        proxy["password"] = settings.scraper_proxy_password
    return proxy


async def _get_browser() -> Any:
    global _browser, _playwright

    # Double-checked under a lock so concurrent first-callers launch only one browser.
    if _browser is not None and _browser.is_connected():
        return _browser

    async with _launch_lock:
        if _browser is not None and _browser.is_connected():
            return _browser

        _playwright = await async_playwright().start()
        launch_args: dict[str, Any] = {
            "headless": True,
            # Chromium's sandbox is unavailable in many container environments and
            # this process only ever visits pages robots.txt already permits.
            "args": ["--disable-dev-shm-usage", "--no-sandbox"],
        }
        proxy = _proxy_config()
        if proxy:
            launch_args["proxy"] = proxy

        _browser = await _playwright.chromium.launch(**launch_args)
        print(
            f"[dynamic] browser launched (proxy: {'yes' if proxy else 'no'})",
            flush=True,
        )

    return _browser


async def close_browser() -> None:
    """Releases the shared browser. Called on application shutdown."""
    global _browser, _playwright
    if _browser is not None:
        try:
            await _browser.close()
        except PlaywrightError:
            pass
        _browser = None
    if _playwright is not None:
        try:
            await _playwright.stop()
        except (PlaywrightError, RuntimeError):
            pass
        _playwright = None


async def fetch_page_dynamic(url: str, timeout_sec: int | None = None) -> str:
    """Loads a page in a real browser and returns the rendered HTML.

    Same contract as `static_fetcher.fetch_page`: returns HTML or raises
    FetchError, and honours robots.txt plus the per-domain rate limit first.
    """
    if not await robots_gate.can_fetch(url):
        raise FetchError(
            ScrapeErrorReason.ROBOTS_DISALLOWED,
            f"robots.txt disallows {url} for our user agent",
        )

    await robots_gate.wait_for_turn(url)

    timeout_ms = (timeout_sec or settings.scraper_timeout_sec) * 1000
    browser = await _get_browser()

    context = None
    try:
        context = await browser.new_context(
            user_agent=settings.scraper_user_agent,
            viewport={"width": 1400, "height": 900},
            # Identify honestly even here; the browser is for rendering and TLS,
            # not for pretending to be someone else.
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        page = await context.new_page()

        response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

        # Client-side directories finish populating after DOMContentLoaded. Idle
        # is best-effort: pages with long-polling or analytics never go idle, and
        # timing out here is not a failure.
        try:
            await page.wait_for_load_state("networkidle", timeout=min(8000, timeout_ms))
        except PlaywrightTimeout:
            pass

        status = response.status if response else 0
        if status == 401:
            raise FetchError(ScrapeErrorReason.LOGIN_REQUIRED, "HTTP 401 in browser")
        if status == 403:
            raise FetchError(
                ScrapeErrorReason.BLOCKED,
                "HTTP 403 even in a real browser — the block is not fingerprint-based "
                "(likely IP reputation; a proxy would be required)",
            )
        if status >= 400:
            raise FetchError(ScrapeErrorReason.HTTP_ERROR, f"HTTP {status} in browser")

        return await page.content()

    except PlaywrightTimeout as exc:
        raise FetchError(ScrapeErrorReason.TIMEOUT, str(exc)) from exc
    except FetchError:
        raise
    except PlaywrightError as exc:
        raise FetchError(ScrapeErrorReason.HTTP_ERROR, str(exc)) from exc
    finally:
        if context:
            try:
                await context.close()
            except PlaywrightError:
                pass
