from fastapi import APIRouter

from app.api.v1 import admin, health, memories


api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(memories.router)
api_router.include_router(admin.router)
