"""Faculty directory extraction.

There is no standard markup for a university faculty page, so this uses layered
heuristics rather than per-university selectors: find repeated "person-like"
blocks, pull a name, title, email and profile link from each.

Deliberately conservative. A missed person costs one lead; a wrongly-extracted
one costs reviewer trust and an AI enrichment call. Anything that does not look
like a real person's name is dropped.
"""

import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from ..core.schemas import ExtractedPerson

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

# Words that signal an academic role, used to spot a title line near a name.
TITLE_KEYWORDS = (
    "professor",
    "lecturer",
    "reader",
    "fellow",
    "researcher",
    "scientist",
    "chair",
    "director",
    "head of",
    "postdoc",
    "principal investigator",
    "emeritus",
)

# Navigation and boilerplate text that superficially resembles a name.
#
# Two capitalised words is a weak signal on its own — real university menus are
# full of "Guest Lecture", "Explore More", "Grievance Redressal", "Project Work".
# Every entry here was observed as an actual false positive while probing live
# university sites, so resist trimming the list.
NAME_STOPWORDS = {
    "about",
    "admission",
    "admissions",
    "alumni",
    "all",
    "apply",
    "announcement",
    "board",
    "campus",
    "cell",
    "centre",
    "center",
    "chair",
    "college",
    "committee",
    "contact",
    "convocation",
    "council",
    "course",
    "curriculum",
    "department",
    "directory",
    "download",
    "email",
    "events",
    "explore",
    "facility",
    "faculty",
    "gallery",
    "grievance",
    "guest",
    "home",
    "hostel",
    "info",
    "institute",
    "lab",
    "laboratory",
    "learn more",
    "lecture",
    "library",
    "link",
    "login",
    "menu",
    "message",
    "more",
    "news",
    "notice",
    "overview",
    "peoples",
    "people",
    "personal",
    "placement",
    "policy",
    "portal",
    "profile",
    "programme",
    "program",
    "project",
    "read more",
    "redressal",
    "research",
    "resource",
    "school",
    "search",
    "seminar",
    "skip",
    "staff",
    "student",
    "students",
    "teaching",
    "tender",
    "university",
    "view profile",
    "webmail",
    "webpage",
    "website",
    "welcome",
    "workshop",
}

# Unicode ranges are written as escapes, not literal characters, so the pattern
# does not depend on this file's encoding. À-ɏ covers Latin-1
# Supplement through Latin Extended-B (accented European names).
_NAME_CHAR = r"[A-Za-zÀ-ɏ'’-]"

NAME_RE = re.compile(
    r"^(?:(?:Dr|Prof|Professor|Mr|Mrs|Ms|Miss)\.?\s+)?"
    rf"[A-ZÀ-ɏ]{_NAME_CHAR}+"                          # first name
    r"(?:\s+[A-Z]\.?)?"                                          # optional middle initial
    r"(?:\s+(?:van|von|de|del|della|di|da|el|al|bin|ibn)\.?)?"   # name particles
    rf"\s+[A-ZÀ-ɏ]{_NAME_CHAR}+$"                      # surname
)


def _looks_like_name(text: str) -> bool:
    """True if the text plausibly is a person's name, not a nav label."""
    cleaned = " ".join(text.split())
    if not (4 <= len(cleaned) <= 60):
        return False
    if cleaned.lower() in NAME_STOPWORDS:
        return False
    if any(word in cleaned.lower() for word in NAME_STOPWORDS):
        return False
    if any(char.isdigit() for char in cleaned):
        return False
    return bool(NAME_RE.match(cleaned))


def _find_title_near(block: Tag) -> str | None:
    """Looks for an academic title in a person block's text."""
    for text in block.stripped_strings:
        lowered = text.lower()
        if any(keyword in lowered for keyword in TITLE_KEYWORDS) and len(text) < 120:
            return " ".join(text.split())
    return None


def _extract_email(block: Tag) -> str | None:
    # A mailto: link is far more reliable than regex over visible text, which
    # picks up generic department addresses.
    for anchor in block.find_all("a", href=True):
        href = anchor["href"]
        if isinstance(href, str) and href.lower().startswith("mailto:"):
            address = href[7:].split("?")[0].strip()
            if EMAIL_RE.fullmatch(address):
                return address.lower()

    match = EMAIL_RE.search(block.get_text(" ", strip=True))
    return match.group(0).lower() if match else None


# Role addresses that belong to an office, not a person. Emailing these reaches
# a front desk, not the researcher — worse than having no address at all,
# because it looks like a real contact in the CRM.
GENERIC_EMAIL_PREFIXES = (
    "registrar",
    "hod",
    "head",
    "office",
    "admin",
    "administrator",
    "info",
    "enquiry",
    "enquiries",
    "contact",
    "webmaster",
    "web",
    "dean",
    "director",
    "principal",
    "secretary",
    "support",
    "help",
    "helpdesk",
    "noreply",
    "no-reply",
    "postmaster",
    "library",
    "accounts",
    "finance",
    "admission",
    "admissions",
    "placement",
    "training",
    "chairman",
    "convenor",
    "coordinator",
    "department",
    "dept",
    "chemistry",
    "physics",
    "office365",
)


def _name_tokens(name: str) -> list[str]:
    cleaned = stripped = "".join(c.lower() if c.isalnum() else " " for c in name)
    return [t for t in cleaned.split() if len(t) > 1 and t not in ("dr", "prof", "mr", "ms", "mrs")]


def pick_personal_email(addresses: list[str], name: str) -> str | None:
    """Chooses the address most likely to belong to this person.

    Faculty profile pages routinely list both the researcher's address and the
    department's. Preferring the one whose local part echoes the person's name
    is what keeps `registrar@` out of the CRM.
    """
    if not addresses:
        return None

    tokens = _name_tokens(name)
    surname = tokens[-1] if tokens else ""

    scored: list[tuple[int, str]] = []
    for address in {a.lower().strip() for a in addresses}:
        local = address.split("@")[0]
        local_alnum = "".join(c for c in local if c.isalnum())

        if any(local.startswith(p) for p in GENERIC_EMAIL_PREFIXES):
            continue

        score = 0
        if surname and surname in local_alnum:
            score += 10
        for token in tokens:
            if token in local_alnum:
                score += 3
        # Initial + surname, the most common academic convention (asahoo@…).
        if tokens and surname and local_alnum.startswith(tokens[0][0] + surname):
            score += 6

        if score > 0:
            scored.append((score, address))

    if not scored:
        return None

    scored.sort(key=lambda x: (-x[0], len(x[1])))
    return scored[0][1]


def extract_emails_from_page(html: str) -> list[str]:
    """Every address on a page — mailto links first, then visible text."""
    soup = BeautifulSoup(html, "lxml")
    found: list[str] = []

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if isinstance(href, str) and href.lower().startswith("mailto:"):
            address = href[7:].split("?")[0].strip().lower()
            if EMAIL_RE.fullmatch(address) and address not in found:
                found.append(address)

    for match in EMAIL_RE.finditer(soup.get_text(" ", strip=True)):
        address = match.group(0).lower()
        if address not in found:
            found.append(address)

    return found


def _extract_profile_url(block: Tag, base_url: str) -> str | None:
    """Finds the link most likely to be this person's profile page."""
    base_host = urlparse(base_url).netloc

    for anchor in block.find_all("a", href=True):
        href = anchor["href"]
        if not isinstance(href, str) or href.lower().startswith(("mailto:", "tel:", "#")):
            continue

        absolute = urljoin(base_url, href)
        # Stay on the university's own domain — offsite links are usually
        # publisher or social pages, not profiles.
        if urlparse(absolute).netloc != base_host:
            continue
        # Matched as path prefixes, not whole segments: IIT Bombay's chemistry
        # department links profiles as "/facultyuserview/<name>", others use
        # "/people/<name>", "/member/<id>", "/person/<id>", "/~login".
        if re.search(r"/(people|faculty|profile|staff|directory|member|person|user|~)", absolute.lower()):
            return absolute

    return None


def _candidate_blocks(soup: BeautifulSoup) -> list[Tag]:
    """Finds repeated container elements that each likely hold one person.

    Faculty directories are nearly always a repeated card or list-item pattern,
    so grouping by (tag, css class) and keeping the largest repeated group finds
    the listing without knowing the site.
    """
    groups: dict[tuple[str, str], list[Tag]] = {}

    for element in soup.find_all(["li", "article", "div", "tr"]):
        if not isinstance(element, Tag):
            continue
        classes = element.get("class")
        key = (element.name, " ".join(sorted(classes)) if classes else "")
        if not key[1]:
            continue
        groups.setdefault(key, []).append(element)

    repeated = [blocks for blocks in groups.values() if 3 <= len(blocks) <= 400]
    if not repeated:
        return []

    # Prefer the group whose members most often contain a name-shaped heading.
    def score(blocks: list[Tag]) -> int:
        return sum(1 for b in blocks[:40] if _extract_name(b))

    repeated.sort(key=score, reverse=True)
    best = repeated[0]
    return best if score(best) >= 2 else []


def _extract_name(block: Tag) -> str | None:
    """Pulls a person's name from a block, preferring heading and link text."""
    for tag_name in ("h1", "h2", "h3", "h4", "h5", "a", "strong", "span"):
        for element in block.find_all(tag_name):
            text = " ".join(element.get_text(" ", strip=True).split())
            if _looks_like_name(text):
                return text
    return None


def _extract_department(block: Tag) -> str | None:
    """A department named by the markup itself (`class="department"`, as on IIT Jammu's cards)."""
    element = block.find(class_=re.compile(r"\b(department|dept)\b", re.I))
    if not isinstance(element, Tag):
        return None
    text = " ".join(element.get_text(" ", strip=True).split())
    return text if 2 <= len(text) <= 120 else None


def _institute_domain(source_url: str) -> str:
    host = urlparse(source_url).netloc.lower().split(":")[0]
    return host[4:] if host.startswith("www.") else host


USERNAME_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,39}")
_TABLE_NAME_WORD = re.compile(rf"(?:{_NAME_CHAR}+\.?|[A-Z]\.)+")


def _table_name(cell: str) -> str | None:
    """A Name-column cell as a person's name, or None.

    The column header already says these are names, so the card parser's strict
    two-word shape is relaxed: Indian names are often three or four words, a
    single given name, an initial ("C. S. Yadav"), a lowercase surname, or carry
    a role in brackets ("Subrata Ghosh(Chairperson)").
    """
    cleaned = " ".join(re.sub(r"\(.*?\)", " ", cell).split()).strip(" ,")
    words = cleaned.split(" ")
    if not (2 <= len(cleaned) <= 60 and 1 <= len(words) <= 6) or any(c.isdigit() for c in cleaned):
        return None
    # Whole words only: the card check's substring test rejects "Masakapalli" for "all".
    if any(w.lower().strip('.') in NAME_STOPWORDS for w in words) or not all(_TABLE_NAME_WORD.fullmatch(w) for w in words):
        return None
    return " ".join(w[:1].upper() + w[1:] for w in words)
SECTION_RE = re.compile(r"\b(school|department|centre|center|division|discipline)\b", re.I)


def _table_email(cell_text: str, name: str, domain: str) -> str | None:
    """An Email column cell: a full address, or bare usernames on the institute's domain.

    IIT Mandi lists "varun" for varun@iitmandi.ac.in, and sometimes a role
    account first ("chairscee,satyajit"); the one closest to the name is kept.
    """
    found = EMAIL_RE.findall(cell_text)
    if found:
        return pick_personal_email([a.lower() for a in found], name) or found[0].lower()
    tokens = [t.strip().lower() for t in re.split(r"[,;/\s]+", cell_text) if t.strip()]
    addresses = [f"{t}@{domain}" for t in tokens if USERNAME_RE.fullmatch(t)]
    if not addresses:
        return None
    return pick_personal_email(addresses, name) or addresses[-1]


def _table_section(table: Tag) -> str | None:
    """The school or department heading just above a table, if there is one."""
    for text in table.find_all_previous(string=True, limit=8):
        cleaned = " ".join(str(text).split())
        if not cleaned or text.find_parent("table") is not None:
            continue
        return cleaned if len(cleaned) <= 120 and SECTION_RE.search(cleaned) else None
    return None


def _parse_tables(soup: BeautifulSoup, source_url: str) -> list[ExtractedPerson]:
    """People from directory tables: a header row naming the columns (Name, Designation, Email, ...).

    Plain `<tr>` rows carry no CSS class, so the repeated-block search never sees
    them (IIT Mandi's all-faculty page: one such table per school).
    """
    domain = _institute_domain(source_url)
    people: list[ExtractedPerson] = []
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) < 4:
            continue
        header = [" ".join(c.get_text(" ", strip=True).split()).lower() for c in rows[0].find_all(["th", "td"])]

        def column(*words: str) -> int | None:
            return next((i for i, h in enumerate(header) if any(w in h for w in words)), None)

        name_col = column("name")
        if name_col is None:
            continue
        title_col = column("designation", "title", "position", "rank")
        email_col = column("email", "e-mail", "mail")
        dept_col = column("department", "school", "centre", "discipline")
        section = _table_section(table)

        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) <= name_col:
                continue
            text = lambda i: " ".join(cells[i].get_text(" ", strip=True).split()) if i is not None and i < len(cells) else ""
            name = _table_name(text(name_col))
            if not name:
                continue
            title = text(title_col) or None
            email = (_extract_email(cells[email_col]) if email_col is not None and email_col < len(cells) and "@" in str(cells[email_col]) else None) \
                or (_table_email(text(email_col), name, domain) if email_col is not None and text(email_col) else None)
            if not (title or email):
                continue
            people.append(
                ExtractedPerson(
                    name=name,
                    title=title,
                    department=text(dept_col) or section,
                    email=email,
                    profile_url=_extract_profile_url(row, source_url),
                )
            )
    return people


def parse_faculty_page(html: str, source_url: str) -> list[ExtractedPerson]:
    """Extracts people from a faculty directory page."""
    soup = BeautifulSoup(html, "lxml")

    # Strip chrome so navigation menus cannot masquerade as person blocks.
    for tag in soup.find_all(["nav", "header", "footer", "script", "style", "aside"]):
        tag.decompose()

    people: list[ExtractedPerson] = []
    seen_names: set[str] = set()

    for block in _candidate_blocks(soup):
        name = _extract_name(block)
        if not name:
            continue

        key = name.lower()
        if key in seen_names:
            continue

        title = _find_title_near(block)
        email = _extract_email(block)
        profile_url = _extract_profile_url(block, source_url)

        # A name-shaped string is not enough. Real faculty entries carry at least
        # one of an academic title, an email, or a link to a profile page;
        # navigation items carry none of the three. Requiring corroboration is
        # what stops "Guest Lecture" and "Grievance Redressal" being filed as
        # researchers — which would waste an AI enrichment call each and pollute
        # the review queue.
        if not (title or email or profile_url):
            continue

        seen_names.add(key)
        bio = " ".join(block.get_text(" ", strip=True).split())

        people.append(
            ExtractedPerson(
                name=name,
                title=title,
                department=_extract_department(block),
                email=email,
                profile_url=profile_url,
                bio=bio[:600] if len(bio) > 40 else None,
            )
        )

    for person in _parse_tables(soup, source_url):
        if person.name.lower() not in seen_names:
            seen_names.add(person.name.lower())
            people.append(person)

    return people


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
