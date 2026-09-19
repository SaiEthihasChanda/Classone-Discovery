"""Scraper service — FastAPI.

Scope, deliberately narrow: fetch pages, extract structured data, return JSON.
This service holds no database connection and makes no AI calls. Node owns the
data layer and all OpenAI usage.

Phase 1 ships the health endpoint, config, and the robots.txt gate. Phase 2 adds
the faculty, news and grant scrape routes on top of that gate.

Run:  uvicorn app.main:app --reload --port 8000
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from .api import routes_enrich, routes_health, routes_scrape
from .core.config import settings
from .scrapers.dynamic_fetcher import close_browser


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    # The shared Chromium process outlives individual requests, so it has to be
    # closed explicitly or it is left orphaned on shutdown.
    await close_browser()


app = FastAPI(
    title="Class One Scraper Service",
    description="Stateless fetch-and-extract service for lead discovery.",
    version="0.3.0",
    lifespan=lifespan,
)

app.include_router(routes_health.router)
app.include_router(routes_scrape.router)
app.include_router(routes_enrich.router)


@app.get("/")
async def root() -> dict[str, object]:
    return {
        "service": "scraper-service",
        "docs": "/docs",
        "endpoints": ["/health", "/scrape/faculty", "/scrape/news"],
        "robots_enforcement": settings.scraper_respect_robots,
    }
