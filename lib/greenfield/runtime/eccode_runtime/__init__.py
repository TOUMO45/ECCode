"""eccode_runtime: the ECCode engine-owned ASGI guard. Vendored into an app tree by the engine; do not edit.

Mount with one line in the app factory: ``app.add_middleware(EccodeGuard)``.
"""

from .guard import EccodeGuard

__all__ = ["EccodeGuard"]
