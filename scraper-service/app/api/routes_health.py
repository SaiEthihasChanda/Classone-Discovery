from fastapi import APIRouter

from ..core.config import settings
from ..core.schemas import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness check. The Node backend surfaces this in its own /api/health."""
    return HealthResponse(
        status="ok",
        service="scraper-service",
        robots_enforcement=settings.scraper_respect_robots,
        request_delay_ms=settings.scraper_request_delay_ms,
    )
