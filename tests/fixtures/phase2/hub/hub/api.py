from fastapi import APIRouter

from . import health_routes, orders_routes, tree_routes

api_router = APIRouter(prefix="/api")
api_router.include_router(orders_routes.router)
api_router.include_router(health_routes.router)
api_router.include_router(tree_routes.router)
