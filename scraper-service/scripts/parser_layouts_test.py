"""Offline checks for directory layouts the generic card parser used to miss.

Each fixture is a cut-down copy of a real institute's markup (names changed):
  - per-school tables with Name / Designation / Email, the email given as a bare
    username (IIT Mandi's all-faculty page);
  - cards with a `class="department"` line (IIT Jammu's faculty page);
  - a script-built shell versus a rendered page, for the browser fallback.

No network, no service needed:
    .venv\\Scripts\\python.exe scripts\\parser_layouts_test.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.scrapers.faculty_scraper import parse_faculty_page  # noqa: E402
from app.scrapers.tiered_fetcher import looks_unrendered  # noqa: E402

TABLES = """<html><body><h5>Faculty List</h5>
<div class="accordion-button">School of Chemical Sciences</div>
<table class="directory-table"><thead><tr><th>Name</th><th>Designation</th><th>Email</th></tr></thead><tbody>
<tr><td>Asha Rao</td><td>Professor(Chairperson)</td><td>chairscs,asharao</td></tr>
<tr><td>Vikram Nair </td><td>Associate  Professor</td><td>vikram</td></tr>
<tr><td>Meera Iyer</td><td>Assistant Professor</td><td>meera.iyer@gmail.com</td></tr>
<tr><td>Rohan Das</td><td>Adjunct Professor</td><td></td></tr>
</tbody></table>
<div class="accordion-button">School of Mechanical &amp; Materials Engineering</div>
<table class="directory-table"><thead><tr><th>Name</th><th>Designation</th><th>Email</th></tr></thead><tbody>
<tr><td>Kavya Menon</td><td>Professor</td><td>kavya</td></tr>
<tr><td>Arjun Pillai</td><td>Assistant Professor</td><td>arjun_p</td></tr>
<tr><td>Shubhra Roy Chowdhury</td><td>Professor</td><td>src</td></tr>
<tr><td>Preeti</td><td>Assistant Professor</td><td>preeti</td></tr>
<tr><td>Kiran Ghosh(Chairperson)</td><td>Professor</td><td>chairsmme,kiran</td></tr>
<tr><td>C. S. Yadav</td><td>Professor</td><td>csyadav</td></tr>
<tr><td>Nisha Gupta</td><td>Associate Professor</td><td>nisha</td></tr>
</tbody></table>
<table><tr><th>Date</th><th>Event</th></tr><tr><td>1 May</td><td>Convocation</td></tr>
<tr><td>2 May</td><td>Sports Day</td></tr><tr><td>3 May</td><td>Open House</td></tr></table>
</body></html>"""

CARDS = """<html><body><div class="faculty-grid">""" + "".join(
    f"""<div class="faculty-card"><div class="faculty-info"><h3>{name}</h3><p class="designation"> {title} </p>
<p class="department"> {dept} <!-- --></p><a class="profile-btn" href="/faculty/~{login}"> View Profile </a></div></div>"""
    for name, title, dept, login in (
        ("Asha Rao", "Professor", "Chemistry", "asharao"),
        ("Vikram Nair", "Assistant Professor", "Materials Engineering", "vikramnair"),
        ("Meera Iyer", "Associate Professor", "Electrical Engineering", "meeraiyer"),
    )
) + "</div></body></html>"

failures = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global failures
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f"  -> {detail}"))
    failures += 0 if ok else 1


people = {p.name: p for p in parse_faculty_page(TABLES, "https://www.fake-iit.ac.in/allfaculty")}
check("tables: every faculty row read, the events table ignored", len(people) == 11, sorted(people))
check("tables: three-word, one-word and initialled names kept", all(n in people for n in ("Shubhra Roy Chowdhury", "Preeti", "C. S. Yadav")), sorted(people))
check("tables: a bracketed role is not part of the name", "Kiran Ghosh" in people and people["Kiran Ghosh"].email == "kiran@fake-iit.ac.in", sorted(people))
check("tables: bare username gets the institute's domain", people["Vikram Nair"].email == "vikram@fake-iit.ac.in", people["Vikram Nair"].email)
check("tables: the personal username beats a role account", people["Asha Rao"].email == "asharao@fake-iit.ac.in", people["Asha Rao"].email)
check("tables: a full address is kept as given", people["Meera Iyer"].email == "meera.iyer@gmail.com", people["Meera Iyer"].email)
check("tables: an empty email cell stays empty", people["Rohan Das"].email is None, people["Rohan Das"].email)
check("tables: underscores survive in usernames", people["Arjun Pillai"].email == "arjun_p@fake-iit.ac.in", people["Arjun Pillai"].email)
check("tables: department from the school heading", people["Kavya Menon"].department == "School of Mechanical & Materials Engineering", people["Kavya Menon"].department)
check("tables: designation as title", people["Vikram Nair"].title == "Associate Professor", people["Vikram Nair"].title)

cards = {p.name: p for p in parse_faculty_page(CARDS, "https://www.fake-iit.ac.in/faculty")}
check("cards: all three read", len(cards) == 3, sorted(cards))
check("cards: department from class=department", cards["Vikram Nair"].department == "Materials Engineering", cards["Vikram Nair"].department)
check("cards: profile link kept", cards["Asha Rao"].profile_url == "https://www.fake-iit.ac.in/faculty/~asharao", cards["Asha Rao"].profile_url)

shell = '<html><head><script src="main.js"></script></head><body><app-root></app-root><a href="/">Home</a></body></html>'
rendered = "<html><body>" + "".join(f'<a href="/p{i}">Link {i}</a>' for i in range(40)) + "</body></html>"
check("a script-built shell is recognised", looks_unrendered(shell))
check("a normal page is not", not looks_unrendered(rendered))

print(f"\n{'all passed' if failures == 0 else f'{failures} failed'}")
sys.exit(1 if failures else 0)
