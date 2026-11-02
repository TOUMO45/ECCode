from fastapi import APIRouter

from .deco import tagged

router = APIRouter(prefix="/health", tags=["health"])


class Health:
    def ping(self):
        return {"status": "ok"}


router.add_api_route("/ping", Health().ping, methods=["GET"])


@router.get("/version")
@tagged
def version():
    return {"version": "1.0"}
