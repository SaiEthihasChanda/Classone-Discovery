"""Shows what the two-hop faculty-page finder sees on one institute's site.

    .venv\\Scripts\\python.exe scripts\\debug_find_pages.py https://www.iitb.ac.in chemistry chemical material

Prints the homepage links that would be queued (with department guess and
score), then for each department page the second-hop links. Read-only apart
from the fetches themselves; honours robots.txt like everything else.
"""

import asyncio
import sys

sys.path.insert(0, ".")

from app.scrapers.faculty_scraper import parse_faculty_page  # noqa: E402
from app.scrapers.static_fetcher import FetchError, fetch_page  # noqa: E402
from app.scrapers.target_finder import (  # noqa: E402
    DIRECTORY_HINTS,
    _department_guess,
    _links_with_text,
    _score_candidate,
)


async def main(root: str, hints: list[str]) -> None:
    try:
        html = await fetch_page(root, 20)
    except FetchError as exc:
        print("homepage:", exc.reason.value, exc.detail)
        return
    links = _links_with_text(html, root)
    print(f"homepage: {len(html)} chars, {len(links)} same-site links")
    queued = []
    for url, text in links:
        dept = _department_guess(url, text, hints)
        score = _score_candidate(url, text) + (20 if dept else 0)
        if score > 0 or dept:
            queued.append((score, url, text, dept))
    queued.sort(reverse=True)
    for score, url, text, dept in queued[:25]:
        print(f"  {score:3d} {dept or '-':12} {url}  [{text[:40]}]")
    if not queued:
        print("  (nothing queued) — first 30 links were:")
        for url, text in links[:30]:
            print("   ", url, f"[{text[:40]}]")
    for score, url, text, dept in [q for q in queued if q[3]][:4]:
        print(f"\n-- {url}")
        try:
            sub = await fetch_page(url, 20)
        except FetchError as exc:
            print("   ", exc.reason.value, exc.detail)
            continue
        people = parse_faculty_page(sub, url)
        print(f"   {len(sub)} chars, {len(people)} people parsed")
        for s_url, s_text in _links_with_text(sub, url):
            hay = f"{s_url} {s_text}".lower()
            if any(h in hay for h in DIRECTORY_HINTS):
                print(f"   -> {s_url} [{s_text[:40]}]")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:] or ["chemistry", "chemical", "material", "biolog"]))
