import re
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator, model_validator

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}$"
)

Status = Literal["todo", "in_progress", "done"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegisterIn(StrictModel):
    email: StrictStr
    password: Annotated[StrictStr, Field(min_length=8, max_length=128)]

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip()
        if len(v) > 254 or not EMAIL_RE.match(v) or ".." in v:
            raise ValueError("invalid email address")
        return v.lower()


class LoginIn(StrictModel):
    email: StrictStr
    password: StrictStr


class UserOut(BaseModel):
    id: int
    email: str
    role: str


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


def _clean_title(v: str) -> str:
    v = v.strip()
    if not 1 <= len(v) <= 200:
        raise ValueError("title must be 1 to 200 characters after trimming")
    return v


class TaskCreateIn(StrictModel):
    title: StrictStr
    description: Annotated[StrictStr, Field(max_length=2000)] = ""

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        return _clean_title(v)


class TaskPatchIn(StrictModel):
    title: StrictStr | None = None
    description: Annotated[StrictStr, Field(max_length=2000)] | None = None
    status: Status | None = None

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data):
        if isinstance(data, dict):
            if not data:
                raise ValueError("at least one of title, description, status is required")
            for key, value in data.items():
                if value is None and key in ("title", "description", "status"):
                    raise ValueError(f"{key} must not be null")
        return data

    @field_validator("title")
    @classmethod
    def _title(cls, v):
        return None if v is None else _clean_title(v)


def iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class TaskOut(BaseModel):
    id: int
    title: str
    description: str
    status: Status
    owner_id: int
    created_at: str

    @classmethod
    def of(cls, task) -> "TaskOut":
        return cls(
            id=task.id,
            title=task.title,
            description=task.description,
            status=task.status,
            owner_id=task.owner_id,
            created_at=iso_utc(task.created_at),
        )
