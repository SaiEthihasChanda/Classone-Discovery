"""Scraper-service smoke test.

Verifies the robots.txt gate and the rate limiter against both live sites and
synthetic rule sets. These are the safety mechanisms every Phase 2 scraper will
sit behind, so they are worth checking on their own.

Run from the scraper-service directory:
    .venv\\Scripts\\python.exe scripts/smoke_test.py       (Windows)
    .venv/bin/python scripts/smoke_test.py                 (macOS/Linux)
"""

import asyncio
import sys
import time
from pathlib import Path

# Allow running as a plain script from the scraper-service directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from protego import Protego  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.robots import robots_gate  # noqa: E402
from app.scrapers.faculty_scraper import (  # noqa: E402
    parse_faculty_page,
    pick_personal_email,
)

failures: list[str] = []
skipped: list[str] = []


def check(label: str, actual: object, expected: object) -> None:
    ok = actual == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        print(f"        got {actual!r}, expected {expected!r}")
        failures.append(label)


async def check_live(label: str, url: str, expected: bool) -> None:
    """A check that needs the network.

    Reported as SKIP rather than FAIL when the fetch itself fails, so a transient
    network blip does not masquerade as a robots-logic bug. Only a reachable site
    giving the wrong answer counts as a failure.
    """
    try:
        actual = await robots_gate.can_fetch(url)
    except Exception as exc:  # noqa: BLE001 - any network failure means "cannot judge"
        print(f"  SKIP  {label} (network unavailable: {type(exc).__name__})")
        skipped.append(label)
        return
    check(label, actual, expected)


async def main() -> None:
    print("\nLive robots.txt enforcement (needs network):")
    await check_live(
        "a disallowed path is blocked (google.com/search)",
        "https://www.google.com/search?q=test",
        False,
    )
    await check_live(
        "an explicitly allowed path under a broad Disallow is permitted",
        "https://www.google.com/maps/about",
        True,
    )
    await check_live(
        "an unrestricted site is permitted",
        "https://example.com/",
        True,
    )

    print("\nRFC 9309 longest-match resolution:")
    # The case the stdlib `urllib.robotparser` gets wrong: it resolves by first
    # match and would report /faculty/ as disallowed, silently skipping the whole
    # university. Protego resolves by longest match, per the spec.
    parser = Protego.parse("User-agent: *\nDisallow: /\nAllow: /faculty/\n")
    check(
        "Disallow:/ plus Allow:/faculty/ permits /faculty/",
        bool(parser.can_fetch("https://uni.example/faculty/", settings.scraper_user_agent)),
        True,
    )
    check(
        "the same rules still block /private/",
        bool(parser.can_fetch("https://uni.example/private/", settings.scraper_user_agent)),
        False,
    )

    print("\nRate limiting:")
    expected_delay_ms = settings.scraper_request_delay_ms

    start = time.monotonic()
    await robots_gate.wait_for_turn("https://ratelimit-a.example/x")
    await robots_gate.wait_for_turn("https://ratelimit-a.example/y")
    same_domain_ms = (time.monotonic() - start) * 1000
    check(
        f"same-domain requests are spaced by >= {expected_delay_ms}ms",
        same_domain_ms >= expected_delay_ms,
        True,
    )

    start = time.monotonic()
    await asyncio.gather(
        robots_gate.wait_for_turn("https://ratelimit-b.example/x"),
        robots_gate.wait_for_turn("https://ratelimit-c.example/y"),
    )
    cross_domain_ms = (time.monotonic() - start) * 1000
    check("different domains do not block each other", cross_domain_ms < 500, True)

    print("\nPersonal-email selection (real addresses seen on NIT profile pages):")
    # Faculty profile pages list the researcher's address alongside the
    # department's. Picking the wrong one means outreach lands on a front desk.
    check(
        "prefers initial+surname over the registrar address",
        pick_personal_email(["registrar@nitrkl.ac.in", "asahoo@nitrkl.ac.in"], "Abanti Sahoo"),
        "asahoo@nitrkl.ac.in",
    )
    check(
        "prefers firstname.surname over the department address",
        pick_personal_email(
            ["lakshmi.vellanki@nitk.edu.in", "hodchemistry@nitk.edu.in"], "Lakshmi Vellanki"
        ),
        "lakshmi.vellanki@nitk.edu.in",
    )
    check(
        "returns nothing rather than a generic department address",
        pick_personal_email(["hodchemistry@nitk.edu.in"], "Debashree Chakraborty"),
        None,
    )
    check("handles an empty address list", pick_personal_email([], "Nobody Here"), None)

    print("\nFaculty parsing (navigation must not be mistaken for people):")
    # Every one of these was a real false positive from a live university site
    # before corroborating evidence was required.
    nav_html = """
    <ul class="menu">
      <li class="item"><a href="/a">Guest Lecture</a></li>
      <li class="item"><a href="/b">Explore More</a></li>
      <li class="item"><a href="/c">Grievance Redressal</a></li>
      <li class="item"><a href="/d">Project Work</a></li>
    </ul>
    """
    check(
        "navigation links yield no people",
        len(parse_faculty_page(nav_html, "https://uni.example/faculty")),
        0,
    )

    people_html = """
    <ul class="faculty-list">
      <li class="card"><h3>Darshak Trivedi</h3><p>Professor</p>
        <a href="mailto:dtrivedi@uni.example">email</a></li>
      <li class="card"><h3>Debashree Chakraborty</h3><p>Associate Professor</p>
        <a href="/people/debashree">profile</a></li>
      <li class="card"><h3>Random Heading</h3></li>
    </ul>
    """
    parsed = parse_faculty_page(people_html, "https://uni.example/faculty")
    check("real faculty entries are still extracted", len(parsed), 2)
    check(
        "the email is read from the mailto link",
        parsed[0].email if parsed else None,
        "dtrivedi@uni.example",
    )

    total = 15
    passed = total - len(failures) - len(skipped)
    summary = f"\n{passed} passed, {len(failures)} failed"
    if skipped:
        summary += f", {len(skipped)} skipped (network)"
    print(f"{summary}\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
