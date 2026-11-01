"""Bearer-token authentication and role checks."""
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select

from . import db
from .models import User


def user_for_token(token):
    with db.SessionLocal() as session:
        user = session.execute(select(User).where(User.token == token)).scalar_one_or_none()
    if user is None or not user.tokens_valid:
        return None
    return user


def current_user(authorization: str | None = Header(default=None)) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    user = user_for_token(authorization[7:].strip())
    if user is None:
        raise HTTPException(status_code=401, detail="invalid token")
    return user


def require_role(*roles):
    def dependency(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail=f"requires role {' or '.join(roles)}")
        return user
    return dependency


require_admin = require_role("admin")
require_writer = require_role("admin", "member")
