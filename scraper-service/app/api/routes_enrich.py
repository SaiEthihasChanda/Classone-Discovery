"""Per-lead enrichment and paper reading, called by the Node backend.

Both endpoints are bounded by a page budget and never raise for a single bad
page: every failure is reported in `errors` next to whatever did succeed, in
the same way the discovery scrapers behave.
"""

import asyncio

from fastapi import APIRouter

from ..core.schemas import (
    EnrichLeadRequest,
    EnrichLeadResponse,
    PaperTextRequest,
    PaperTextResponse,
    PaperTextResult,
    ScrapeError,
    ScrapeErrorReason,
    TextSnippet,
)
from ..scrapers.enrichment import (
    extract_contact,
    extract_snippets,
    fetch_orcid,
    find_equipment_pages,
    html_to_text,
    name_matches,
)
from ..scrapers.faculty_scraper import extract_emails_from_page, parse_faculty_page, pick_personal_email
from ..scrapers.paper_text import fetch_paper, methods_section
from ..scrapers.static_fetcher import FetchError, fetch_page
from ..scrapers.tiered_fetcher import fetch_with_escalation

router = APIRouter(prefix="/scrape", tags=["enrich"])


def _error(target: str, exc: Exception) -> ScrapeError:
    if isinstance(exc, FetchError):
        return ScrapeError(target=target, reason=exc.reason, detail=exc.detail)
    return ScrapeError(target=target, reason=ScrapeErrorReason.UNKNOWN, detail=f"{type(exc).__name__}: {exc}")


@router.post("/enrich-lead", response_model=EnrichLeadResponse)
async def enrich_lead(request: EnrichLeadRequest) -> EnrichLeadResponse:
    opts = request.options
    out = EnrichLeadResponse(job_id=request.job_id)
    budget = opts.max_pages

    def add_snippets(url: str, text: str) -> None:
        for s in extract_snippets(text, request.instrument_terms):
            out.snippets.append(TextSnippet(url=url, text=s))

    async def fetch(url: str, *, escalate: bool = False) -> str | None:
        nonlocal budget
        if budget <= 0:
            return None
        budget -= 1
        out.pages_visited.append(url)
        try:
            if escalate:
                outcome = await fetch_with_escalation(
                    url, opts.timeout_sec_per_page, allow_browser=opts.allow_browser, allow_proxy=False
                )
                return outcome.html
            return await fetch_page(url, opts.timeout_sec_per_page)
        except Exception as exc:  # noqa: BLE001 - reported, never fatal
            out.errors.append(_error(url, exc))
            return None

    # --- 1. Profile page: given, or found in the institute's directory ------
    profile_url = request.profile_url
    if not profile_url:
        for directory_url in request.directory_urls[:3]:
            html = await fetch(directory_url, escalate=True)
            if not html:
                continue
            try:
                people = parse_faculty_page(html, directory_url)
            except Exception as exc:  # noqa: BLE001
                out.errors.append(_error(directory_url, exc))
                continue
            # Only a directory that parsed into a real list counts as checked;
            # an empty parse says nothing about whether the person is there.
            if len(people) >= 3:
                out.directory_checked = True
                if out.directory_listed is None:
                    out.directory_listed = False
            match = next((p for p in people if name_matches(p.name, request.name)), None)
            if match:
                out.directory_listed = True
                # The directory row itself often carries the email.
                if match.email:
                    out.email = match.email
                if match.title and not out.designation:
                    out.designation = match.title
                if match.department and not out.department:
                    out.department = match.department
                if match.profile_url:
                    profile_url = match.profile_url
                break

    websites: list[str] = []

    if profile_url:
        html = await fetch(profile_url)
        if html:
            out.profile_url = profile_url
            contact = extract_contact(html, request.name, profile_url)
            out.email = out.email or contact.email
            out.phone = out.phone or contact.phone
            out.designation = out.designation or contact.designation
            out.department = out.department or contact.department
            websites.extend(contact.websites)
            add_snippets(profile_url, html_to_text(html))
            # A profile page on the institute site sometimes has its own
            # facilities/lab links; treat them like a lab site's.
            for eq in find_equipment_pages(html, profile_url, limit=2):
                if eq not in websites:
                    websites.append(eq)

    # --- 2. ORCID: lab URLs and current role -------------------------------
    if opts.use_orcid and request.orcid:
        try:
            record = await fetch_orcid(request.orcid, opts.timeout_sec_per_page)
            for w in record.websites:
                if w not in websites:
                    websites.append(w)
            out.designation = out.designation or record.designation
            out.department = out.department or record.department
            if not out.email and record.emails:
                out.email = pick_personal_email(record.emails, request.name) or record.emails[0]
        except Exception as exc:  # noqa: BLE001
            out.errors.append(_error(f"orcid:{request.orcid}", exc))

    # --- 3. Lab / personal sites and their facilities pages ----------------
    if opts.follow_lab_sites:
        for site in websites[:3]:
            if budget <= 0:
                break
            html = await fetch(site)
            if not html:
                continue
            out.websites.append(site)
            add_snippets(site, html_to_text(html))
            if not out.email:
                out.email = pick_personal_email(extract_emails_from_page(html), request.name)
            for page in find_equipment_pages(html, site, limit=3):
                if budget <= 0:
                    break
                sub = await fetch(page)
                if not sub:
                    continue
                add_snippets(page, html_to_text(sub))
    else:
        out.websites = websites[:5]

    # De-duplicate snippets across pages: the same sentence on a home page
    # and a facilities page is one piece of evidence, not two.
    seen: set[str] = set()
    unique: list[TextSnippet] = []
    for s in out.snippets:
        key = s.text.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(s)
    out.snippets = unique[:60]

    return out


@router.post("/paper-text", response_model=PaperTextResponse)
async def paper_text(request: PaperTextRequest) -> PaperTextResponse:
    out = PaperTextResponse(job_id=request.job_id)

    async def one(paper) -> None:
        try:
            text, kind = await fetch_paper(paper.url, request.timeout_sec_per_page)
        except Exception as exc:  # noqa: BLE001
            out.errors.append(_error(paper.url, exc))
            return
        section = methods_section(text)
        out.results.append(
            PaperTextResult(
                id=paper.id,
                url=paper.url,
                kind=kind,
                chars=len(text),
                snippets=extract_snippets(section, request.instrument_terms, max_snippets=20),
            )
        )

    # Concurrent across papers; the per-domain delay still serialises one publisher.
    await asyncio.gather(*(one(p) for p in request.papers[:10]))
    return out
