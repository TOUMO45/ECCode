"""The hub application: every route sits behind the /api prefix of a router that is included from another module."""
from fastapi import FastAPI

from .api import api_router

app = FastAPI(title="hub")
app.include_router(api_router)
