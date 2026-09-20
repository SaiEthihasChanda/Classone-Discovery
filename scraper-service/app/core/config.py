"""Configuration for the scraper service.

Reads the same `.env` at the repo root that the Node backend and the frontend use,
so there is one place to change a setting.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",  # The shared .env holds Node/Vite vars this service ignores.
    )

    scraper_port: int = 8000

    # Sent on every outbound request so site owners can identify and contact us.
    scraper_user_agent: str = (
        "ClassOneSalesBot/1.0 (+mailto:example@example.com; purpose: academic lead research)"
    )

    # Minimum gap between requests to the SAME domain. Politeness, and it keeps us
    # off rate limiters.
    scraper_request_delay_ms: int = 1500

    # A hard gate, not a suggestion: when true, a disallowed path is never fetched.
    scraper_respect_robots: bool = True

    # Per-page ceiling so one slow site cannot stall a whole discovery run.
    scraper_timeout_sec: int = 20

    # Identity sent to Vidwan (vidwan.inflibnet.ac.in). Empty = the same
    # identified User-Agent as everything else. The project owner decided on
    # 20 Sep 2026 to use Vidwan's public search despite its robots.txt; if the
    # site refuses the identified agent, set VIDWAN_USER_AGENT in .env — that
    # is the owner's call to make, not the code's default.
    vidwan_user_agent: str = ""

    # --- Escalation tiers ---------------------------------------------------
    # Tier 2: render pages in a real browser. Needed for client-side-rendered
    # faculty directories, which look identical to empty pages over plain HTTP.
    # Costs ~10-30x a plain GET, so it only runs when a cheaper fetch came back
    # unusable.
    scraper_enable_browser: bool = True

    # Tier 3: route the browser through a proxy. Measured: most 403s here survive
    # a real browser with a real TLS fingerprint, which means they are keyed on
    # IP reputation — a different egress IP is the only thing that changes the
    # outcome. Leave blank to disable; requires a proxy provider.
    scraper_proxy_url: str = ""
    scraper_proxy_username: str = ""
    scraper_proxy_password: str = ""


settings = Settings()
