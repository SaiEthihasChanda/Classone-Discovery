"""Discover working faculty-directory URLs for Indian institutes.

Replaces hand-guessing URLs (which mostly 404) with crawling each institution's
own site for directory links. No evasion: follows published links, honours
robots.txt, identifies itself, and rate-limits per domain.

Run from the scraper-service directory:
    .venv\\Scripts\\python.exe scripts/find_targets.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.scrapers.target_finder import find_faculty_pages  # noqa: E402

# Department subdomains are used as roots where they exist, because Indian
# institutes usually host directories there rather than on the main site.
ROOTS: list[tuple[str, str]] = [
    ("IIT Bombay Chemistry", "https://www.chem.iitb.ac.in/"),
    ("IIT Bombay MEMS", "https://www.met.iitb.ac.in/"),
    ("IIT Madras Chemistry", "https://chem.iitm.ac.in/"),
    ("IIT Delhi Chemistry", "https://chemistry.iitd.ac.in/"),
    ("IIT Kanpur Chemistry", "https://www.iitk.ac.in/chm/"),
    ("IIT Roorkee", "https://www.iitr.ac.in/departments/CY/"),
    ("IIT Hyderabad Chem", "https://chy.iith.ac.in/"),
    ("IIT Indore Chemistry", "https://chemistry.iiti.ac.in/"),
    ("IIT Ropar Chemistry", "https://www.iitrpr.ac.in/chemistry/"),
    ("IIT Gandhinagar", "https://chem.iitgn.ac.in/"),
    ("IIT BHU Chemistry", "https://iitbhu.ac.in/dept/chy"),
    ("NIT Rourkela Chem", "https://www.nitrkl.ac.in/CH/"),
    ("NIT Karnataka Chem", "https://chemistry.nitk.ac.in/"),
    ("NIT Trichy Chemistry", "https://www.nitt.edu/home/academics/departments/chemistry/"),
    ("NIT Warangal", "https://nitw.ac.in/department/chemistry/"),
    ("NIT Durgapur Chem", "https://nitdgp.ac.in/department/chemistry"),
    ("MNIT Jaipur Chem", "https://mnit.ac.in/dept_chemistry/"),
    ("IIIT Hyderabad", "https://www.iiit.ac.in/"),
    ("IIIT Bangalore", "https://www.iiitb.ac.in/"),
    ("IIIT Allahabad", "https://www.iiita.ac.in/"),
]


async def main() -> None:
    print(f"\nCrawling {len(ROOTS)} institution sites for faculty directories.")
    print("Rate-limited per domain, so this takes a few minutes.\n")

    found_total = 0
    usable: list[tuple[str, dict]] = []

    async def handle(name: str, root: str) -> None:
        nonlocal found_total
        results = await find_faculty_pages(root, max_probes=6)

        if results and "error" in results[0]:
            print(f"  X    {name:<24} {results[0]['error']}")
            return
        if not results:
            print(f"  --   {name:<24} no directory pages found")
            return

        best = results[0]
        found_total += 1
        usable.append((name, best))
        print(
            f"  OK   {name:<24} {best['people']:>3} people, "
            f"{best['emails']:>3} emails, {best['profiles']:>3} profiles"
        )
        print(f"       {best['url']}")
        print(f"       e.g. {', '.join(best['sample'])}")

    await asyncio.gather(*(handle(n, u) for n, u in ROOTS))

    print(f"\n{found_total}/{len(ROOTS)} institutions yielded a usable directory.\n")

    if usable:
        print("Add to docs/scrape-targets.yaml:\n")
        for name, best in sorted(usable, key=lambda x: -x[1]["people"]):
            print(f"  - university_name: {name}")
            print(f"    url: {best['url']}")
            print(f"    enabled: true  # {best['people']} people, {best['emails']} emails")


if __name__ == "__main__":
    asyncio.run(main())
