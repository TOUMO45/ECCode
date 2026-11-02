from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/trees", tags=["trees"])


class Node(BaseModel):
    """A request body that requires a field of its own type: an example built without a depth limit never ends."""

    name: str = "n"
    parent: Optional["Node"]


def depth(node):
    return 1 + (depth(node.parent) if node.parent else 0)


@router.post("")
def measure(node: Node):
    return {"depth": depth(node)}
