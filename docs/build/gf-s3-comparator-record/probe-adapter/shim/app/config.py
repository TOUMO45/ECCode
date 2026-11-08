"""Shim of the engine's Settings: only carries the three env-var settings the PRD defines."""
from dataclasses import dataclass


@dataclass
class Settings:
    database_url: object = None
    admin_email: object = None
    token_ttl_seconds: object = None
