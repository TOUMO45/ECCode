from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import config, security
from app.db import make_engine, make_sessionmaker, run_migrations
from app.models import AuthToken, Task, User
from app.schemas import LoginIn, RegisterIn, TaskCreateIn, TaskOut, TaskPatchIn, TokenOut, UserOut

SQLITE_MAX_INT = 2**63 - 1
INVALID_CREDENTIALS = "Invalid email or password"


def utcnow() -> datetime:
    """Naive UTC now (SQLite stores naive datetimes; all stored times are UTC)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def task_not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Task not found")


def get_db(request: Request):
    db: Session = request.app.state.sessionmaker()
    try:
        yield db
    finally:
        db.close()


class Principal:
    def __init__(self, user: User, token_hash: str):
        self.user = user
        self.token_hash = token_hash

    @property
    def is_admin(self) -> bool:
        return self.user.role == "admin"


def current_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    header = request.headers.get("authorization")
    if not header:
        raise unauthorized()
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise unauthorized()
    token_hash = security.hash_token(token)
    row = db.execute(
        select(AuthToken, User).join(User, User.id == AuthToken.user_id).where(AuthToken.token_hash == token_hash)
    ).first()
    if row is None:
        raise unauthorized("Invalid or expired token")
    auth_token, user = row
    if auth_token.expires_at <= utcnow():
        db.delete(auth_token)
        db.commit()
        raise unauthorized("Invalid or expired token")
    return Principal(user, token_hash)


def load_task_for(principal: Principal, task_id: int, db: Session) -> Task:
    # Ids that cannot exist in SQLite are simply unknown (avoids integer overflow errors).
    if task_id < 1 or task_id > SQLITE_MAX_INT:
        raise task_not_found()
    stmt = select(Task).where(Task.id == task_id)
    if not principal.is_admin:
        # Ownership is part of the lookup: a foreign task is indistinguishable from a missing one.
        stmt = stmt.where(Task.owner_id == principal.user.id)
    task = db.execute(stmt).scalar_one_or_none()
    if task is None:
        raise task_not_found()
    return task


def create_app(database_url: str | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = make_engine(database_url or config.database_url())
        run_migrations(engine)
        app.state.engine = engine
        app.state.sessionmaker = make_sessionmaker(engine)
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(title="Task Tracker", version="1.0.0", lifespan=lifespan)

    @app.post("/v1/register", status_code=201, response_model=UserOut, operation_id="registerUser")
    def register(body: RegisterIn, db: Session = Depends(get_db)) -> UserOut:
        if db.execute(select(User.id).where(User.email == body.email)).first() is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="Email already registered")
        role = "admin" if config.admin_email() == body.email else "user"
        user = User(
            email=body.email, password_hash=security.hash_password(body.password), role=role, created_at=utcnow()
        )
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, detail="Email already registered")
        return UserOut(id=user.id, email=user.email, role=user.role)

    @app.post("/v1/login", response_model=TokenOut, operation_id="loginUser")
    def login(body: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
        email = body.email.strip().lower()
        user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if user is None:
            security.burn_password_check(body.password)
            raise unauthorized(INVALID_CREDENTIALS)
        if not security.verify_password(body.password, user.password_hash):
            raise unauthorized(INVALID_CREDENTIALS)
        token = security.new_token()
        now = utcnow()
        db.add(
            AuthToken(
                token_hash=security.hash_token(token),
                user_id=user.id,
                created_at=now,
                expires_at=now + timedelta(seconds=config.token_ttl_seconds()),
            )
        )
        db.commit()
        return TokenOut(access_token=token)

    @app.post("/v1/logout", status_code=204, response_class=Response, operation_id="logoutUser")
    def logout(principal: Principal = Depends(current_principal), db: Session = Depends(get_db)) -> Response:
        db.execute(delete(AuthToken).where(AuthToken.token_hash == principal.token_hash))
        db.commit()
        return Response(status_code=204)

    @app.get("/v1/tasks", response_model=list[TaskOut], operation_id="listTasks")
    def list_tasks(principal: Principal = Depends(current_principal), db: Session = Depends(get_db)):
        stmt = select(Task).order_by(Task.id.asc())
        if not principal.is_admin:
            stmt = stmt.where(Task.owner_id == principal.user.id)
        return [TaskOut.of(t) for t in db.execute(stmt).scalars()]

    @app.post("/v1/tasks", status_code=201, response_model=TaskOut, operation_id="createTask")
    def create_task(
        body: TaskCreateIn, principal: Principal = Depends(current_principal), db: Session = Depends(get_db)
    ) -> TaskOut:
        task = Task(
            title=body.title,
            description=body.description,
            status="todo",
            owner_id=principal.user.id,
            created_at=utcnow(),
        )
        db.add(task)
        db.commit()
        return TaskOut.of(task)

    @app.get("/v1/tasks/{task_id}", response_model=TaskOut, operation_id="getTask")
    def get_task(
        task_id: int, principal: Principal = Depends(current_principal), db: Session = Depends(get_db)
    ) -> TaskOut:
        return TaskOut.of(load_task_for(principal, task_id, db))

    @app.patch("/v1/tasks/{task_id}", response_model=TaskOut, operation_id="updateTask")
    def update_task(
        task_id: int,
        body: TaskPatchIn,
        principal: Principal = Depends(current_principal),
        db: Session = Depends(get_db),
    ) -> TaskOut:
        task = load_task_for(principal, task_id, db)
        for field in body.model_fields_set:
            setattr(task, field, getattr(body, field))
        db.commit()
        return TaskOut.of(task)

    return app


app = create_app()
