"""A small API whose behaviour hides behind inputs the v2 example generator could not make."""
from datetime import time
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, HTTPException
from pydantic import UUID4, AnyHttpUrl, BaseModel, Field

app = FastAPI(title="vault")

# The ids the configuration lists in exampleIds: these items exist in the application.
ITEMS = {
    UUID("00000000-0000-4000-8000-000000000001"): {"name": "bolt", "price_cents": 1250, "weight_g": 33},
    UUID("00000000-0000-4000-8000-000000000002"): {"name": "nut", "price_cents": 399, "weight_g": 12},
}


@app.get("/api/items/{item_id}")
def get_item(item_id: UUID4):
    item = ITEMS.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return {"id": str(item_id), "name": item["name"], "price": f"{item['price_cents'] / 100:.2f}", "weight_g": item["weight_g"]}


class AccountIn(BaseModel):
    email: Annotated[str, Field(json_schema_extra={"format": "email"})]
    display_name: str = Field(min_length=3)


@app.post("/api/accounts", status_code=201)
def create_account(body: AccountIn):
    return {"email": body.email.lower(), "display_name": body.display_name.strip()}


class SignupIn(BaseModel):
    password: str = Field(min_length=8)
    passwordConfirm: str


@app.post("/api/signup")
def signup(body: SignupIn):
    if body.password != body.passwordConfirm:
        raise HTTPException(status_code=422, detail="passwords differ")
    return {"ok": True, "length": len(body.password)}


@app.get("/api/slots")
def slot(at: time):
    return {"slot": at.hour // 6}


class LinkIn(BaseModel):
    link: AnyHttpUrl


@app.post("/api/links")
def add_link(body: LinkIn):
    return {"host": body.link.host}
