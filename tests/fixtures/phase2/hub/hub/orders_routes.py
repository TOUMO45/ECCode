from fastapi import APIRouter, HTTPException

from . import pricing

router = APIRouter(prefix="/orders", tags=["orders"])

ORDERS = {1: [(2, 500), (1, 1250)], 2: [(3, 333)], 3: [(7, 199)]}


@router.get("")
def list_orders():
    return {"orders": [{"id": order_id, "total_cents": pricing.order_total(lines)} for order_id, lines in sorted(ORDERS.items())]}


@router.get("/{order_id}")
def get_order(order_id: int):
    lines = ORDERS.get(order_id)
    if lines is None:
        raise HTTPException(status_code=404, detail="order not found")
    return {"id": order_id, "lines": len(lines), "total_cents": pricing.order_total(lines)}
