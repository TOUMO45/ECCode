"""The ledger API. Roles come from static bearer tokens: admin, member, viewer."""
from fastapi import FastAPI

from .routes import router

app = FastAPI(title="ledger", version="0.1.0")
app.include_router(router, prefix="/api")
