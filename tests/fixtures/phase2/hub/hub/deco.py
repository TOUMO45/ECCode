from functools import wraps


def tagged(fn):
    """A decorator defined in another module: the route's endpoint is this wrapper, not the handler."""

    @wraps(fn)
    def inner(*args, **kwargs):
        return fn(*args, **kwargs)

    return inner
