"""Scrape endpoints called by the Node backend.

Per-target error isolation is the rule throughout: one unreachable or
robots-blocked university must never fail the whole discovery run, so every
target is wrapped and failures are reported alongside successes.
"""

import asyncio

from fastapi import APIRouter

from ..core.schemas import (
    FacultyScrapeRequest,
    FindFacultyPagesRequest,
    FindFacultyPagesResponse,
    FindFacultyPagesResult,
    FoundFacultyPage,
    VidwanRow,
    VidwanSearchRequest,
    VidwanSearchResponse,
    FacultyScrapeResponse,
    FacultyScrapeResult,
    NewsScrapeRequest,
    NewsScrapeResponse,
    NewsScrapeResult,
    ScrapeError,
    ScrapeErrorReason,
    ScrapeStatus,
)
from ..scrapers.faculty_scraper import (
    extract_emails_from_page,
    parse_faculty_page,
    pick_personal_email,
    utc_now,
)
from ..scrapers.news_scraper import (
    candidate_feed_urls,
    looks_like_feed,
    parse_feed,
    parse_news_html,
)
from ..scrapers.static_fetcher import FetchError, fetch_page
from ..scrapers.target_finder import find_department_faculty_pages
from ..scrapers.vidwan import VidwanBlocked, VidwanClient
from ..scrapers.tiered_fetcher import fetch_with_escalation

router = APIRouter(prefix="/scrape", tags=["scrape"])


def _status_for(results: list, errors: list) -> ScrapeStatus:
    if errors and not results:
        return ScrapeStatus.FAILED
    if errors:
        return ScrapeStatus.PARTIAL
    return ScrapeStatus.COMPLETED


@router.post("/faculty", response_model=FacultyScrapeResponse)
async def scrape_faculty(request: FacultyScrapeRequest) -> FacultyScrapeResponse:
    results: list[FacultyScrapeResult] = []
    errors: list[ScrapeError] = []

    async def enrich_emails_from_profiles(people: list) -> None:
        """Second hop: fetch profile pages for people with no email on the index.

        Bounded by `max_profile_fetches` because every fetch waits on the
        per-domain rate limit. Failures are ignored — a missing email is a
        normal outcome, not an error worth reporting to Node.
        """
        budget = request.options.max_profile_fetches
        for person in people:
            if budget <= 0:
                break
            if person.email or not person.profile_url:
                continue

            budget -= 1
            try:
                profile_html = await fetch_page(
                    person.profile_url, request.options.timeout_sec_per_page
                )
            except (FetchError, Exception):  # noqa: B014 - any failure just means no email
                continue

            person.email = pick_personal_email(
                extract_emails_from_page(profile_html), person.name
            )

    async def handle(target) -> None:
        url = target.faculty_page_url
        try:
            # A directory that renders client-side returns 200 with no people in
            # the HTML — indistinguishable from an empty page. Judging the result
            # rather than the status code is what triggers a browser retry.
            def has_people(html: str) -> bool:
                try:
                    return len(parse_faculty_page(html, url)) >= 3
                except Exception:  # noqa: BLE001 - a parse failure means "not sufficient"
                    return False

            outcome = await fetch_with_escalation(
                url,
                request.options.timeout_sec_per_page,
                allow_browser=request.options.allow_browser,
                allow_proxy=request.options.allow_proxy,
                is_sufficient=has_people,
            )
            people = parse_faculty_page(outcome.html, url)

            if request.options.follow_profiles:
                await enrich_emails_from_profiles(people)

            results.append(
                FacultyScrapeResult(
                    source_url=url,
                    university_name=target.university_name,
                    extracted=people,
                    scraped_at=utc_now(),
                    fetch_tier=outcome.tier,
                )
            )
        except FetchError as exc:
            errors.append(ScrapeError(target=url, reason=exc.reason, detail=exc.detail))
        except Exception as exc:  # noqa: BLE001 - a parse bug on one site must not kill the run
            errors.append(
                ScrapeError(
                    target=url,
                    reason=ScrapeErrorReason.PARSE_ERROR,
                    detail=f"{type(exc).__name__}: {exc}",
                )
            )

    # Concurrent across targets; the rate limiter still serialises per domain.
    await asyncio.gather(*(handle(t) for t in request.targets))

    return FacultyScrapeResponse(
        job_id=request.job_id,
        status=_status_for(results, errors),
        results=results,
        errors=errors,
    )


@router.post("/news", response_model=NewsScrapeResponse)
async def scrape_news(request: NewsScrapeRequest) -> NewsScrapeResponse:
    results: list[NewsScrapeResult] = []
    errors: list[ScrapeError] = []

    async def handle(target) -> None:
        timeout = request.options.timeout_sec_per_page
        url = target.news_page_url

        try:
            content = await fetch_page(url, timeout)

            if looks_like_feed(content):
                items = parse_feed(content)
            else:
                # No feed at this URL — probe the conventional locations before
                # falling back to parsing the page's HTML.
                items = []
                for feed_url in candidate_feed_urls(url):
                    try:
                        feed_content = await fetch_page(feed_url, timeout)
                        if looks_like_feed(feed_content):
                            items = parse_feed(feed_content)
                            break
                    except FetchError:
                        continue  # This location has no feed; try the next.

                if not items:
                    items = parse_news_html(content, url)

            results.append(
                NewsScrapeResult(
                    source_url=url,
                    university_name=target.university_name,
                    extracted=items,
                    scraped_at=utc_now(),
                )
            )
        except FetchError as exc:
            errors.append(ScrapeError(target=url, reason=exc.reason, detail=exc.detail))
        except Exception as exc:  # noqa: BLE001
            errors.append(
                ScrapeError(
                    target=url,
                    reason=ScrapeErrorReason.PARSE_ERROR,
                    detail=f"{type(exc).__name__}: {exc}",
                )
            )

    await asyncio.gather(*(handle(t) for t in request.targets))

    return NewsScrapeResponse(
        job_id=request.job_id,
        status=_status_for(results, errors),
        results=results,
        errors=errors,
    )


@router.post("/find-faculty-pages", response_model=FindFacultyPagesResponse)
async def find_faculty_pages_endpoint(request: FindFacultyPagesRequest) -> FindFacultyPagesResponse:
    """Locates department faculty listings from each institute's homepage.

    Backs the roster build: Node knows the 72 institutes and their homepages
    (from OpenAlex) but not where each one keeps its chemistry or materials
    faculty list. Institutes run concurrently; the per-domain delay still
    serialises fetches within one site.
    """
    out = FindFacultyPagesResponse(job_id=request.job_id)

    async def one(inst) -> None:
        pages = await find_department_faculty_pages(
            inst.homepage_url,
            request.department_hints,
            max_probes=request.max_probes_per_institution,
            timeout_sec=request.timeout_sec_per_page,
        )
        if pages and "error" in pages[0]:
            out.results.append(
                FindFacultyPagesResult(institution=inst.name, error=pages[0]["error"], detail=pages[0].get("detail"))
            )
            return
        out.results.append(
            FindFacultyPagesResult(institution=inst.name, pages=[FoundFacultyPage(**p) for p in pages])
        )

    await asyncio.gather(*(one(i) for i in request.institutions))
    return out


@router.post("/vidwan", response_model=VidwanSearchResponse)
async def vidwan_search(request: VidwanSearchRequest) -> VidwanSearchResponse:
    """Searches Vidwan and reads the matching researchers' profiles.

    Sequential and delayed by design (see `scrapers/vidwan.py`). A 403/429
    ends the run with `blocked=true`; whatever was collected before it is
    returned.
    """
    out = VidwanSearchResponse(job_id=request.job_id)
    client = VidwanClient(timeout_sec=request.timeout_sec_per_page, base_url=request.base_url or "https://vidwan.inflibnet.ac.in")
    terms = [t.lower() for t in request.institution_terms if t.strip()]

    def wanted(text: str) -> bool:
        if not terms:
            return True
        hay = text.lower()
        return any(t in hay for t in terms)

    try:
        listings: dict[str, object] = {}
        for query in request.queries:
            try:
                found, pages = await client.search(query, max_pages=request.max_pages_per_query)
            except VidwanBlocked as exc:
                out.blocked = True
                out.errors.append(ScrapeError(target=query, reason=ScrapeErrorReason.BLOCKED, detail=str(exc)))
                break
            except Exception as exc:  # noqa: BLE001
                out.errors.append(ScrapeError(target=query, reason=ScrapeErrorReason.UNKNOWN, detail=f"{type(exc).__name__}: {exc}"))
                continue
            out.pages_fetched += pages
            for item in found:
                listings.setdefault(item.vidwan_id, item)
        out.listing_profiles = len(listings)

        candidates = [l for l in listings.values() if wanted(getattr(l, "card_text", "") + " " + getattr(l, "listing_name", ""))]
        # When the card text carries no institute at all the filter would drop
        # everyone; in that case the profile pages decide.
        if terms and len(candidates) < max(3, len(listings) // 10):
            candidates = list(listings.values())

        for listing in candidates[: request.max_profiles]:
            if out.blocked:
                break
            row = VidwanRow(vidwan_id=listing.vidwan_id, profile_url=listing.profile_url, name=listing.listing_name, card_text=listing.card_text[:600])  # type: ignore[attr-defined]
            if request.fetch_profiles:
                try:
                    p = await client.profile(listing)  # type: ignore[arg-type]
                    row = VidwanRow(
                        vidwan_id=p.vidwan_id, profile_url=p.profile_url, name=p.name or listing.listing_name,  # type: ignore[attr-defined]
                        designation=p.designation or None, institute=p.institute or None, department=p.department or None,
                        state=p.state or None, email=p.email or None, phone=p.phone or None, website=p.website or None,
                        expertise=p.expertise or None, orcid=p.orcid or None, profile_text=p.profile_text or None,
                        card_text=listing.card_text[:600],  # type: ignore[attr-defined]
                    )
                except VidwanBlocked as exc:
                    out.blocked = True
                    out.errors.append(ScrapeError(target=listing.profile_url, reason=ScrapeErrorReason.BLOCKED, detail=str(exc)))  # type: ignore[attr-defined]
                    break
                except Exception as exc:  # noqa: BLE001
                    row.error = f"{type(exc).__name__}: {exc}"
            if terms and not wanted(" ".join(filter(None, [row.institute, row.card_text, row.profile_text or ""]))):
                continue
            out.rows.append(row)
    finally:
        out.requests = client.requests
        await client.aclose()
    return out
