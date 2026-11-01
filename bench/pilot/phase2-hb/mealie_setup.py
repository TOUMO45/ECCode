#!/usr/bin/env python3
"""Setup step of the H-B probe configuration for a Mealie worktree (protocol section 4a, 0.C).

Runs inside the worktree, with the checkout's interpreter, before every probe run:
  1. a fixed SECRET and SESSION_SECRET under DATA_DIR (so tokens are constants),
  2. the database initialized by Mealie's own init_db (alembic head, default group,
     household and admin), exactly as the backend suite starts,
  3. two probe users with FIXED ids in the default group and household,
  4. one long-lived API token row per probe user whose token column is the constant
     JWT the configuration generator computed (ECCODE_HB_USER_TOKEN / ECCODE_HB_ADMIN_TOKEN).
Deterministic by construction: nothing random is written that a probe can observe
through the API except what Mealie itself generates (and the engine normalizes
UUIDs and timestamps).
"""
import os
import sys
from pathlib import Path

USER_ID = "11111111-1111-4111-8111-111111111111"
ADMIN_ID = "22222222-2222-4222-8222-222222222222"
SECRET = "eccode-phase2-hb-fixed-secret-2026"


def main():
    data_dir = Path(os.environ["DATA_DIR"])
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in (".secret", ".session_secret"):
        (data_dir / name).write_text(SECRET)
    user_token = os.environ["ECCODE_HB_USER_TOKEN"]
    admin_token = os.environ["ECCODE_HB_ADMIN_TOKEN"]

    from mealie.core.config import get_app_settings
    from mealie.core.security import hash_password
    from mealie.db.db_setup import session_context
    from mealie.db.init_db import main as init_db_main
    from mealie.repos.all_repositories import get_repositories
    from mealie.schema.user.user import CreateToken

    init_db_main()
    settings = get_app_settings()
    with session_context() as session:
        repos = get_repositories(session, group_id=None, household_id=None)
        assert repos.groups.get_by_name(settings.DEFAULT_GROUP) is not None, "default group missing after init_db"
        for uid, username, admin, token in (
            (USER_ID, "eccode-probe-user", False, user_token),
            (ADMIN_ID, "eccode-probe-admin", True, admin_token),
        ):
            if repos.users.get_one(uid, "id", any_case=False) is None:
                repos.users.create({
                    "id": uid,
                    "username": username,
                    "full_name": username,
                    "email": f"{username}@example.test",
                    "password": hash_password("eccode-probe-password"),
                    "group": settings.DEFAULT_GROUP,
                    "household": settings.DEFAULT_HOUSEHOLD,
                    "admin": admin,
                    "can_invite": admin,
                    "can_manage": admin,
                    "can_manage_household": admin,
                })
            existing = repos.api_tokens.multi_query({"token": token, "user_id": uid})
            if not existing:
                repos.api_tokens.create(CreateToken(name="eccode-hb", user_id=uid, token=token))
    sys.stdout.write("eccode hb setup: ok\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
