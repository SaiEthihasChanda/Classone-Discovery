"""Offline end-to-end test for /scrape/enrich-lead and /scrape/paper-text.

Serves a tiny fake institute on 127.0.0.1 — a faculty directory, a profile
page, a lab website with a facilities page, an HTML paper and a PDF paper —
then calls the running scraper service against it. Nothing leaves the
machine and nothing costs credits, which is the point: the parsing and the
control flow are exercised against realistic markup before a real site is.

Run with the scraper up on :8000:
    .venv\\Scripts\\python.exe scripts\\enrich_fixture_test.py
"""

import json
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"

DIRECTORY = f"""<html><body><h1>Department of Chemistry — Faculty</h1>
<div class="faculty-card"><h3><a href="/people/asha-rao">Dr. Asha Rao</a></h3><p>Professor</p><p>Electrochemistry</p></div>
<div class="faculty-card"><h3><a href="/people/vikram-nair">Prof. Vikram Nair</a></h3><p>Associate Professor</p><a href="mailto:vnair@fake-iit.test">vnair@fake-iit.test</a></div>
<div class="faculty-card"><h3><a href="/people/meera-iyer">Dr. Meera Iyer</a></h3><p>Assistant Professor</p></div>
<div class="faculty-card"><h3><a href="/people/rohan-das">Dr. Rohan Das</a></h3><p>Assistant Professor</p></div>
</body></html>"""

PROFILE = f"""<html><body><nav><a href="/">Home</a></nav>
<h1>Dr. Asha Rao</h1><p>Professor, Department of Chemistry</p>
<p>Phone: +91 22 2576 7890</p>
<p>Email: <a href="mailto:office.chem@fake-iit.test">office.chem@fake-iit.test</a> | <a href="mailto:asha.rao@fake-iit.test">asha.rao@fake-iit.test</a></p>
<p>Research: electrochemical biosensors. Our group routinely uses a PalmSens4 potentiostat for field measurements.</p>
<p><a href="http://127.0.0.1:{PORT}/lab/">Rao Electroanalysis Lab website</a> · <a href="https://scholar.google.com/citations?user=xyz">Google Scholar</a></p>
<footer>© Fake IIT</footer></body></html>"""

LAB_HOME = f"""<html><body><h1>Rao Electroanalysis Lab</h1>
<ul><li><a href="/lab/">Home</a></li><li><a href="/lab/people.html">People</a></li><li><a href="/lab/facilities.html">Facilities &amp; Instruments</a></li><li><a href="/lab/publications.html">Publications</a></li></ul>
<p>We develop screen-printed electrode sensors. Contact: a.rao@fake-iit.test</p>
</body></html>"""

LAB_FACILITIES = """<html><body><h1>Facilities</h1>
<ul>
<li>Autolab PGSTAT302N potentiostat/galvanostat with FRA32M module (Metrohm)</li>
<li>CHI 660E electrochemical workstation (CH Instruments)</li>
<li>Gamry Reference 600+ for impedance work</li>
<li>Sensit Smart handheld potentiostat (PalmSens)</li>
<li>Bruker D8 XRD, FTIR spectrometer</li>
</ul></body></html>"""

PAPER_HTML = """<html><body><h1>A wearable sweat lactate sensor</h1>
<p>Asha Rao<sup>a,*</sup>, Vikram Nair<sup>b</sup></p>
<p>* Corresponding author. E-mail: asha.rao@fake-iit.test (A. Rao); editor@journal.test</p>
<h2>Abstract</h2><p>We report a flexible sensor.</p>
<h2>2. Experimental</h2>
<p>All electrochemical measurements were performed using an EmStat Pico potentiostat (PalmSens BV, The Netherlands) controlled via PSTrace. Impedance spectra were recorded on a Bio-Logic SP-300.</p>
<h2>3. Results and Discussion</h2><p>The sensor showed a Gamry-free linear range… (this line must NOT be in the methods slice).</p>
<h2>References</h2><p>[1] …</p></body></html>"""


def _pdf_with_text(lines: list[str]) -> bytes:
    """A minimal valid single-page PDF whose content stream holds `lines`."""
    content = "BT /F1 11 Tf 40 760 Td 14 TL " + " ".join(
        "(" + line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj T*" for line in lines
    ) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content.encode('latin-1'))} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


PAPER_PDF = _pdf_with_text(
    [
        "Corrosion inhibition of mild steel by a Schiff base",
        "Abstract. A new inhibitor is reported.",
        "2. Materials and Methods",
        "Electrochemical studies were carried out on a CorrTest CS350M workstation",
        "and cross-checked with an Autolab PGSTAT204 (Metrohm).",
        "3. Results",
        "Inhibition efficiency reached 94%.",
    ]
)

REGISTRY_SEARCH = f"""<html><body><h1>Search results</h1>
<ul>
<li><a href="/login">Login</a></li>
<li><a href="/registry/profile/999">Dr. Ashok Rao</a> — Chemistry</li>
<li><a href="/registry/profile/42">Dr. Asha Rao</a> — Electrochemistry</li>
<li><a href="https://elsewhere.test/asha">Asha Rao (offsite)</a></li>
</ul></body></html>"""

REGISTRY_PROFILE = """<html><body><h1>Dr. Asha Rao</h1>
<table>
<tr><th>Designation</th><td>Professor</td></tr>
<tr><th>Department</th><td>Department of Chemistry</td></tr>
<tr><th>Affiliation</th><td>Indian Institute of Science</td></tr>
</table></body></html>"""

REGISTRY_PROFILE_OTHER = """<html><body><h1>Dr. Ashok Rao</h1><p>Affiliation: Somewhere Else University</p></body></html>"""

HOMEPAGE = """<html><body><nav><a href="/">Home</a><a href="/about">About</a><a href="/admissions">Admissions</a></nav>
<h1>Fake IIT</h1>
<h2>Academics</h2>
<ul>
<li><a href="/departments">Departments</a></li>
<li><a href="/dept/chemistry">Department of Chemistry</a></li>
<li><a href="/dept/physics">Department of Physics</a></li>
<li><a href="/dept/mems">Metallurgical Engineering and Materials Science</a></li>
</ul>
<footer><a href="/tenders">Tenders</a><a href="/news">News</a></footer></body></html>"""

DEPT_CHEM = """<html><body><h1>Department of Chemistry</h1>
<ul><li><a href="/dept/chemistry">Home</a></li><li><a href="/dept/chemistry/research">Research</a></li>
<li><a href="/dept/chemistry/faculty">Faculty</a></li><li><a href="/dept/chemistry/students">Students</a></li></ul>
<p>Welcome to the department.</p></body></html>"""

DEPT_MEMS = """<html><body><h1>MEMS</h1><ul><li><a href="/dept/mems/people">People</a></li></ul></body></html>"""

MEMS_PEOPLE = """<html><body><h1>People</h1>
<div class="person"><h3><a href="/people/k-rao">Dr. Kavita Rao</a></h3><p>Professor</p></div>
<div class="person"><h3><a href="/people/s-menon">Dr. Suresh Menon</a></h3><p>Associate Professor</p></div>
<div class="person"><h3><a href="/people/p-jain">Dr. Pooja Jain</a></h3><p>Assistant Professor</p></div>
</body></html>"""

DIRECTORY_WITHOUT = DIRECTORY.replace('<div class="faculty-card"><h3><a href="/people/asha-rao">Dr. Asha Rao</a></h3><p>Professor</p><p>Electrochemistry</p></div>', '')

VIDWAN_FORM = """<html><head><meta name="csrf-token" content="tok123"></head><body>
<form method="POST" action="/profiles/apply-filters"><input type="hidden" name="_token" value="tok123"><input name="q"></form>
</body></html>"""

def _vcard(vid, name, role, subject, inst, loc):
    return (f'<div class="exp-card"><div class="exp-info-side"><h3 class="exp-title"><a href="/profile/{vid}">{name}</a></h3>'
            f'<p class="exp-role-text">{role}</p><div class="adv-pill"><span class="adv-pill-text">{subject}</span></div></div>'
            f'<div class="exp-institution-section"><div class="exp-meta-row exp-meta-row-university"><i class="fa fa-university"></i><span>{inst}</span></div>'
            f'<div class="exp-meta-row exp-meta-row-location"><span>{loc}</span></div></div><a class="exp-link" href="/profile/{vid}">View Profile.</a></div>')

VIDWAN_PAGE1 = ("<html><body><p>60 Total Experts found</p>" + _vcard(1001, "Dr Asha Rao", "Professor", "Chemical Sciences", "Indian Institute of Technology, Bombay", "Mumbai, Maharashtra")
                + _vcard(1002, "Mr Rohan Das", "Research Scholar", "Chemical Sciences", "Indian Institute of Technology, Bombay", "Mumbai, Maharashtra")
                + '<ul class="pagination"><li><a href="/profiles?page=0">«</a></li><li><a href="/profiles?page=1">1</a></li><li><a href="/profiles?page=2">2</a></li></ul></body></html>')

VIDWAN_PAGE2 = ("<html><body><p>60 Total Experts found</p>" + _vcard(1003, "Dr Meera Iyer", "Associate Professor", "Chemical Sciences", "National Institute of Technology Karnataka", "Surathkal, Karnataka")
                + '<ul class="pagination"><li><a href="/profiles?page=1">1</a></li><li><a href="/profiles?page=2">2</a></li></ul></body></html>')

VIDWAN_P1001 = """<html><body><div class="custom_hero_card"><span class="custom_vidwan_pill">VIDWAN ID: 1001</span>
<h2 class="custom_hero_name"><span>Dr</span> Asha Rao</h2>
<div class="custom_hero_info_grid">
<div class="custom_hero_info_item"><i class="fa-solid fa-user-tie"></i><div class="info_text"><strong>Professor</strong><span class="info_sub">| Department of Chemistry</span></div></div>
<div class="custom_hero_info_item"><i class="fa-solid fa-building-columns"></i><div class="info_text"><strong>Indian Institute of Technology Bombay</strong><span class="info_sub">(2009)</span></div></div>
<div class="custom_hero_info_item"><i class="fa-solid fa-location-dot"></i><div class="info_text"><span>Maharashtra</span></div></div></div>
<div class="custom_hero_exp_row"><span class="exp_label">Expertise:</span><span class="custom_hero_exp_badge">Electrochemical biosensors</span><span class="custom_hero_exp_badge">Corrosion</span></div>
<div class="custom_hero_ids_row"><a class="custom_id_badge" href="https://orcid.org/0000-0002-1825-0097">ORCID</a><a class="custom_id_badge" href="https://www.scopus.com/authid/detail.uri?authorId=55666014000">Scopus</a></div>
</div></body></html>"""

VIDWAN_P1002 = """<html><body><h2 class="custom_hero_name">Rohan Das</h2></body></html>"""
VIDWAN_P1003 = """<html><body><div class="custom_hero_card"><h2 class="custom_hero_name"><span>Dr</span> Meera Iyer</h2>
<div class="custom_hero_info_item"><i class="fa-solid fa-user-tie"></i><div class="info_text"><strong>Associate Professor</strong></div></div>
<div class="custom_hero_info_item"><i class="fa-solid fa-building-columns"></i><div class="info_text"><strong>National Institute of Technology Karnataka</strong></div></div></div></body></html>"""

ROUTES: dict[str, tuple[str, bytes]] = {
    "/profiles": ("text/html", VIDWAN_FORM.encode()),
    "/profiles?page=1": ("text/html", VIDWAN_PAGE1.encode()),
    "/profiles?page=2": ("text/html", VIDWAN_PAGE2.encode()),
    "/profile/1001": ("text/html", VIDWAN_P1001.encode()),
    "/profile/1002": ("text/html", VIDWAN_P1002.encode()),
    "/profile/1003": ("text/html", VIDWAN_P1003.encode()),
    "/registry/search": ("text/html", REGISTRY_SEARCH.encode()),
    "/registry/profile/42": ("text/html", REGISTRY_PROFILE.encode()),
    "/registry/profile/999": ("text/html", REGISTRY_PROFILE_OTHER.encode()),
    "/faculty-without": ("text/html", DIRECTORY_WITHOUT.encode()),
    "/robots.txt": ("text/plain", b"User-agent: *\nAllow: /\n"),
    "/faculty": ("text/html", DIRECTORY.encode()),
    "/": ("text/html", HOMEPAGE.encode()),
    "/departments": ("text/html", b"<html><body><ul><li><a href='/dept/chemistry'>Chemistry</a></li></ul></body></html>"),
    "/dept/chemistry": ("text/html", DEPT_CHEM.encode()),
    "/dept/chemistry/faculty": ("text/html", DIRECTORY.encode()),
    "/dept/chemistry/research": ("text/html", b"<html><body><p>Research areas.</p></body></html>"),
    "/dept/chemistry/students": ("text/html", b"<html><body><p>Students list.</p></body></html>"),
    "/dept/physics": ("text/html", b"<html><body><h1>Physics</h1><a href='/dept/physics/faculty'>Faculty</a></body></html>"),
    "/dept/physics/faculty": ("text/html", b"<html><body><div class='p'><h3>Dr. A B</h3><p>Professor</p></div><div class='p'><h3>Dr. C D</h3><p>Professor</p></div><div class='p'><h3>Dr. E F</h3><p>Professor</p></div></body></html>"),
    "/dept/mems": ("text/html", DEPT_MEMS.encode()),
    "/dept/mems/people": ("text/html", MEMS_PEOPLE.encode()),
    "/people/asha-rao": ("text/html", PROFILE.encode()),
    "/lab/": ("text/html", LAB_HOME.encode()),
    "/lab/facilities.html": ("text/html", LAB_FACILITIES.encode()),
    "/lab/people.html": ("text/html", b"<html><body><h1>People</h1><p>Asha Rao, PI.</p></body></html>"),
    "/lab/publications.html": ("text/html", b"<html><body><h1>Publications</h1></body></html>"),
    "/paper.html": ("text/html", PAPER_HTML.encode()),
    "/paper.pdf": ("application/pdf", PAPER_PDF),
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        # Vidwan's filter form: a POST that redirects to the first listing page.
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        if self.path == "/profiles/apply-filters" and "_token=tok123" in body:
            self.send_response(302)
            self.send_header("Location", "/profiles?page=1")
            self.end_headers()
            return
        self.send_response(419)
        self.end_headers()

    def do_GET(self):  # noqa: N802
        # Listing pages are keyed with their query string; everything else without.
        path = self.path if self.path in ROUTES else self.path.split("?")[0]
        if path not in ROUTES:
            self.send_response(404)
            self.end_headers()
            return
        ctype, body = ROUTES[path]
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # Silence the default request log.
        return


def post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main() -> int:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    failures = 0

    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        print(("  PASS  " if ok else "  FAIL  ") + label + (f"  — {detail}" if detail and not ok else ""))
        failures += 0 if ok else 1

    terms = ["PalmSens", "PalmSens4", "Sensit Smart", "EmStat Pico", "CorrTest", "CS350M", "Autolab", "PGSTAT302N",
             "PGSTAT204", "Gamry", "Reference 600", "CH Instruments", "CHI660E", "BioLogic", "Bio Logic", "SP-300"]

    print("\n/scrape/enrich-lead — directory → profile → ORCID(skipped) → lab site → facilities")
    r = post("http://localhost:8000/scrape/enrich-lead", {
        "job_id": "t1", "name": "Asha Rao", "institution_name": "Fake IIT",
        "directory_urls": [f"{BASE}/faculty"], "instrument_terms": terms,
        "options": {"max_pages": 8, "follow_lab_sites": True, "use_orcid": False, "allow_browser": False, "timeout_sec_per_page": 10},
    })
    check("found the profile page from the directory", r.get("profile_url") == f"{BASE}/people/asha-rao", str(r.get("profile_url")))
    check("picked the personal email over the office address", r.get("email") == "asha.rao@fake-iit.test", str(r.get("email")))
    check("read the designation", r.get("designation") == "Professor", str(r.get("designation")))
    check("read the department", (r.get("department") or "").startswith("Department of Chemistry"), str(r.get("department")))
    check("read the phone", "2576 7890" in (r.get("phone") or ""), str(r.get("phone")))
    check("followed the lab website, not Google Scholar", r.get("websites") == [f"{BASE}/lab/"], str(r.get("websites")))
    visited = r.get("pages_visited", [])
    check("visited the facilities page", f"{BASE}/lab/facilities.html" in visited, str(visited))
    texts = " || ".join(s["text"] for s in r.get("snippets", []))
    for expect in ["PGSTAT302N", "CHI 660E", "Reference 600", "Sensit Smart", "PalmSens4"]:
        check(f"snippet mentions {expect}", expect in texts, texts[:300])
    urls = {s["url"] for s in r.get("snippets", [])}
    check("snippets carry their source URL", f"{BASE}/lab/facilities.html" in urls, str(urls))
    check("no errors", not r.get("errors"), json.dumps(r.get("errors")))
    check("stayed within the page budget", len(visited) <= 8, str(len(visited)))

    print("\n/scrape/paper-text — HTML paper (methods section only) and PDF paper")
    r = post("http://localhost:8000/scrape/paper-text", {
        "job_id": "t2", "instrument_terms": terms, "timeout_sec_per_page": 10,
        "papers": [{"id": "W1", "url": f"{BASE}/paper.html", "title": "sweat"}, {"id": "W2", "url": f"{BASE}/paper.pdf", "title": "corrosion"}],
    })
    by_id = {x["id"]: x for x in r.get("results", [])}
    h = by_id.get("W1", {})
    p = by_id.get("W2", {})
    check("HTML paper parsed", h.get("kind") == "html", json.dumps(r.get("errors")))
    ht = " || ".join(h.get("snippets", []))
    check("HTML: EmStat Pico found in methods", "EmStat Pico" in ht, ht)
    check("HTML: Bio-Logic SP-300 found in methods", "SP-300" in ht, ht)
    check("HTML: results section excluded (no 'Gamry-free' line)", "Gamry-free" not in ht, ht)
    check("PDF paper parsed", p.get("kind") == "pdf", json.dumps(r.get("errors")))
    pt = " || ".join(p.get("snippets", []))
    check("PDF: CorrTest CS350M found", "CS350M" in pt, pt)
    check("PDF: PGSTAT204 found", "PGSTAT204" in pt, pt)
    check("HTML: author-block emails returned", "asha.rao@fake-iit.test" in h.get("emails", []), str(h.get("emails")))
    check("no errors", not r.get("errors"), json.dumps(r.get("errors")))

    print("\n/scrape/find-faculty-pages — homepage → department → faculty listing (two hops)")
    r = post("http://localhost:8000/scrape/find-faculty-pages", {
        "job_id": "t5",
        "institutions": [{"name": "Fake IIT", "homepage_url": f"{BASE}/"}],
        "department_hints": ["chemistry", "metallurg", "material", "biolog"],
        "max_probes_per_institution": 20, "timeout_sec_per_page": 10,
    })
    res = (r.get("results") or [{}])[0]
    pages = {pg["url"]: pg for pg in res.get("pages", [])}
    check("no error for the institute", not res.get("error"), str(res))
    chem = pages.get(f"{BASE}/dept/chemistry/faculty")
    check("found the chemistry faculty page two hops down", chem is not None, str(list(pages)))
    check("chemistry page attributed to the chemistry department", bool(chem) and chem.get("department") == "chemistry", str(chem))
    check("chemistry page reached with 4 people and the Faculty label", bool(chem) and chem.get("people") == 4 and chem.get("label") == "Faculty", str(chem))
    mems = pages.get(f"{BASE}/dept/mems/people")
    check("found the MEMS people page via the 'metallurg' hint", mems is not None and mems.get("department") in ("metallurg", "material"), str(mems))
    check("physics faculty page NOT followed (no hint)", f"{BASE}/dept/physics/faculty" not in pages, str(list(pages)))

    print("\n/scrape/affiliation — registries + directory")
    r = post("http://localhost:8000/scrape/affiliation", {
        "job_id": "t3", "name": "Asha Rao", "institution_name": "Fake IIT",
        "known_institutions": ["Fake IIT", "Indian Institute of Science", "Indian Institute of Technology Bombay"],
        "directory_urls": [f"{BASE}/faculty-without"],
        "registries": [{"key": "vidwan", "label": "Vidwan", "search_url": f"{BASE}/registry/search?q={{name}}"}],
        "timeout_sec_per_page": 10, "allow_browser": False,
    })
    check("directory was checked", r.get("directory_checked") is True, str(r))
    check("directory no longer lists the person", r.get("directory_listed") is False, str(r.get("directory_listed")))
    hits = r.get("hits", [])
    reg = [h for h in hits if h["source"] == "vidwan"]
    check("exactly one registry profile matched (not Ashok Rao, not the offsite link)", len(reg) == 1 and reg[0]["matched_name"].endswith("Asha Rao"), str(reg))
    check("registry profile affiliation read from the labelled table", reg and reg[0]["institution"] == "Indian Institute of Science", str(reg))
    check("registry designation and department read", reg and reg[0]["designation"] == "Professor" and (reg[0]["department"] or "").startswith("Department of Chemistry"), str(reg))
    check("no errors", not r.get("errors"), json.dumps(r.get("errors")))

    r = post("http://localhost:8000/scrape/affiliation", {
        "job_id": "t4", "name": "Asha Rao", "institution_name": "Fake IIT", "known_institutions": [],
        "directory_urls": [f"{BASE}/faculty"], "registries": [], "timeout_sec_per_page": 10, "allow_browser": False,
    })
    check("directory that still lists the person → listed, with a directory hit", r.get("directory_listed") is True and any(h["source"] == "directory" for h in r.get("hits", [])), str(r))

    print("\n/scrape/vidwan — CSRF → filter POST → paginated listing → profiles")
    r = post("http://localhost:8000/scrape/vidwan", {
        "job_id": "t6", "queries": ["Indian Institute of Technology Bombay"], "max_pages_per_query": 10,
        "max_profiles": 20, "fetch_profiles": True, "institution_terms": ["Indian Institute of Technology Bombay", "IIT Bombay"],
        "timeout_sec_per_page": 10, "base_url": BASE,
    })
    rows = {x["vidwan_id"]: x for x in r.get("rows", [])}
    check("read the site total and followed 1-indexed pagination: 2 pages", r.get("site_total") == 60 and r.get("pages_fetched") == 2, f"{r.get('site_total')} {r.get('pages_fetched')}")
    check("3 listed, 2 kept after the institute filter (comma in 'Technology, Bombay' tolerated)", r.get("listing_profiles") == 3 and set(rows) == {"1001", "1002"}, str(list(rows)))
    a = rows.get("1001", {})
    check("hero grid parsed: designation, department, institute, years", a.get("designation") == "Professor" and a.get("department") == "Department of Chemistry" and a.get("institute") == "Indian Institute of Technology Bombay" and a.get("years") == "2009", str(a))
    check("expertise badges, ORCID and Scopus ids", a.get("expertise") == "Electrochemical biosensors; Corrosion" and a.get("orcid") == "0000-0002-1825-0097" and a.get("scopus_id") == "55666014000", str(a))
    check("honorific stripped; subject from the card", a.get("name") == "Asha Rao" and a.get("subject") == "Chemical Sciences", str(a))
    b = rows.get("1002", {})
    check("student card returned without a profile fetch", b.get("card_only") is True and b.get("designation") == "Research Scholar", str(b))
    check("only one profile fetched, not blocked, no errors", r.get("profiles_fetched") == 1 and r.get("blocked") is False and not r.get("errors"), json.dumps(r))

    server.shutdown()
    print(f"\n{'ALL PASSED' if failures == 0 else f'{failures} FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
