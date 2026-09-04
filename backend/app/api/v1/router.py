from fastapi import APIRouter

from app.api.v1 import health, memories


api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(memories.router)
