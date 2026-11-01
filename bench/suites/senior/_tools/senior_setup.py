#!/usr/bin/env python3
"""Probe principals for the Senior Bench authorization grade (bench/suites/senior/_tools/grade-authorization.js).

Runs inside the graded Mealie tree, with its interpreter, on a fresh DATA_DIR:
  1. a fixed SECRET and SESSION_SECRET under DATA_DIR (tokens are constants);
  2. the database initialized by Mealie's own init_db (alembic head, default group, household, admin);
  3. a second household in the default group and a second group with its own household;
  4. five principals with FIXED ids: userA and userA2 (default group, default household: household
     peers), userB (default group, household 2), userC (group 2, household 3) and admin (default group
     and household, admin);
  5. one long-lived API token row per principal whose token column is the constant JWT the grade computed;
  6. one recipe per principal, with a fixed slug, owned by that principal (the IDOR probes' objects).
Deterministic by construction. Adapted from bench/pilot/phase2-hb/mealie_setup.py.
"""
import os
import sys
from pathlib import Path

IDS = {
    "userA": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "userA2": "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2",
    "userB": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "userC": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "admin": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
}
SECRET = "eccode-senior-bench-fixed-secret-2026"
GROUP2 = "eccode-group-2"
HOUSEHOLD2 = "eccode-household-2"
HOUSEHOLD3 = "eccode-household-3"


def main():
    data_dir = Path(os.environ["DATA_DIR"])
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in (".secret", ".session_secret"):
        (data_dir / name).write_text(SECRET)
    tokens = {name: os.environ["ECCODE_SB_TOKEN_" + name.upper()] for name in IDS}
    sys.path.insert(0, os.getcwd())  # the graded tree: `mealie` imports from it, as the probe does

    from mealie.core.config import get_app_settings
    from mealie.core.security import hash_password
    from mealie.db.db_setup import session_context
    from mealie.db.init_db import main as init_db_main
    from mealie.repos.all_repositories import get_repositories
    from mealie.schema.user.user import CreateToken, GroupBase
    from mealie.services.group_services.group_service import GroupService
    from mealie.services.household_services.household_service import HouseholdService
    from mealie.schema.household.household import HouseholdCreate

    init_db_main()
    settings = get_app_settings()
    with session_context() as session:
        repos = get_repositories(session, group_id=None, household_id=None)
        g1 = repos.groups.get_by_name(settings.DEFAULT_GROUP)
        assert g1 is not None, "default group missing after init_db"
        g2 = repos.groups.get_by_name(GROUP2) or GroupService.create_group(repos, GroupBase(name=GROUP2))
        g1_repos = get_repositories(session, group_id=g1.id, household_id=None)
        g2_repos = get_repositories(session, group_id=g2.id, household_id=None)
        if g1_repos.households.get_by_name(HOUSEHOLD2) is None:
            HouseholdService.create_household(g1_repos, HouseholdCreate(name=HOUSEHOLD2))
        if g2_repos.households.get_by_name(HOUSEHOLD3) is None:
            HouseholdService.create_household(g2_repos, HouseholdCreate(name=HOUSEHOLD3))
        principals = (
            ("userA", settings.DEFAULT_GROUP, settings.DEFAULT_HOUSEHOLD, False),
            ("userA2", settings.DEFAULT_GROUP, settings.DEFAULT_HOUSEHOLD, False),
            ("userB", settings.DEFAULT_GROUP, HOUSEHOLD2, False),
            ("userC", GROUP2, HOUSEHOLD3, False),
            ("admin", settings.DEFAULT_GROUP, settings.DEFAULT_HOUSEHOLD, True),
        )
        for name, group, household, admin in principals:
            uid = IDS[name]
            if repos.users.get_one(uid, "id", any_case=False) is None:
                repos.users.create({
                    "id": uid,
                    "username": "eccode-" + name.lower(),
                    "full_name": "eccode " + name,
                    "email": "eccode-%s@example.test" % name.lower(),
                    "password": hash_password("eccode-probe-password"),
                    "group": group,
                    "household": household,
                    "admin": admin,
                    "can_invite": admin,
                    "can_manage": admin,
                    "can_manage_household": admin,
                })
                try:  # newer trees: the organize permission (default True for a plain member)
                    repos.users.patch(uid, {"can_organize": admin})
                except Exception:  # noqa: BLE001
                    pass
            if not repos.api_tokens.multi_query({"token": tokens[name], "user_id": uid}):
                repos.api_tokens.create(CreateToken(name="eccode-senior", user_id=uid, token=tokens[name]))
        # One recipe per principal, in their own group and household.
        try:
            from mealie.schema.recipe import Recipe
            for name, group, household, _ in principals:
                user = repos.users.get_one(IDS[name], "id", any_case=False)
                slug = "eccode-recipe-" + name.lower()
                user_repos = get_repositories(session, group_id=user.group_id, household_id=getattr(user, "household_id", None))
                if user_repos.recipes.get_one(slug, "slug") is None:
                    fields = {"name": "eccode recipe " + name, "slug": slug, "user_id": user.id, "group_id": user.group_id}
                    if getattr(user, "household_id", None) is not None:
                        fields["household_id"] = user.household_id
                    user_repos.recipes.create(Recipe(**fields))
        except Exception as e:  # noqa: BLE001
            sys.stdout.write("eccode senior setup: recipes not seeded (%s)\n" % e)
    sys.stdout.write("eccode senior setup: ok\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
