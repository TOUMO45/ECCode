#!/usr/bin/env python3
"""Setup step of the H-B probe configuration for a Mealie worktree (protocol section 4a, 0.C).

Runs inside the worktree, with the checkout's interpreter, before every probe run:
  1. a fixed SECRET and SESSION_SECRET under DATA_DIR (so tokens are constants),
  2. the database initialized by Mealie's own init_db (alembic head, default group,
     household and admin), exactly as the backend suite starts,
  3. two probe users with FIXED ids in the default group and household,
  4. one long-lived API token row per probe user whose token column is the constant
     JWT the configuration generator computed (ECCODE_HB_USER_TOKEN / ECCODE_HB_ADMIN_TOKEN),
  5. a small generic data set created through Mealie's own API as the admin probe user, so
     that probes find existing data instead of "not found": one recipe named "alpha" (the
     first string example the probe generator uses for a path parameter) with ingredients,
     instructions and nutrition, a category, a tag and a tool, a meal plan entry, a shopping
     list with two items, a cookbook and a comment. Every call is fail-soft and its HTTP
     status is printed; nothing here is chosen per change under test.
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


def populate(admin_token):
    """Create the generic data set through the API. Returns the printed notes; never raises."""
    notes = []
    try:
        from fastapi.testclient import TestClient
        from mealie.app import app
    except Exception as e:  # noqa: BLE001
        return ["populate: cannot import the app (%s)" % e]
    headers = {"Authorization": "Bearer " + admin_token}
    with TestClient(app) as client:
        def call(method, url, **kwargs):
            try:
                r = client.request(method, url, headers=headers, **kwargs)
            except Exception as e:  # noqa: BLE001
                notes.append("%s %s raised %s" % (method, url, type(e).__name__))
                return None
            notes.append("%s %s %d" % (method, url, r.status_code))
            return r if r.status_code < 300 else None

        def body(r):
            try:
                return r.json() if r is not None else None
            except Exception:  # noqa: BLE001
                return None

        call("POST", "/api/recipes", json={"name": "alpha"})
        recipe = body(call("GET", "/api/recipes/alpha"))
        if isinstance(recipe, dict):
            recipe.update({
                "description": "A generic recipe for probes",
                "recipeServings": 4,
                "prepTime": "15 minutes",
                "cookTime": "30 minutes",
                "recipeIngredient": [{"quantity": 2, "note": "flour"}, {"quantity": 1, "note": "milk"}],
                "recipeInstructions": [{"text": "Mix the flour and the milk."}, {"text": "Bake."}],
                "nutrition": {"calories": "250", "fatContent": "10"},
            })
            call("PUT", "/api/recipes/alpha", json=recipe)
        for kind in ("categories", "tags", "tools"):
            call("POST", "/api/organizers/" + kind, json={"name": "alpha"})
        recipe = body(call("GET", "/api/recipes/alpha")) or {}
        if recipe.get("id"):
            call("POST", "/api/households/mealplans", json={"date": "2026-01-05", "entryType": "dinner", "title": "alpha", "text": "x", "recipeId": recipe["id"]})
            call("POST", "/api/comments", json={"recipeId": recipe["id"], "text": "A comment."})
        shopping = body(call("POST", "/api/households/shopping/lists", json={"name": "alpha"}))
        if isinstance(shopping, dict) and shopping.get("id"):
            call("POST", "/api/households/shopping/items", json={"shoppingListId": shopping["id"], "note": "milk", "quantity": 2})
            call("POST", "/api/households/shopping/items", json={"shoppingListId": shopping["id"], "note": "flour", "quantity": 1, "checked": True})
        call("POST", "/api/households/cookbooks", json={"name": "alpha"})
    return notes


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
    notes = populate(admin_token)
    failed = [n for n in notes if not n.rsplit(" ", 1)[-1].isdigit() or int(n.rsplit(" ", 1)[-1]) >= 300]
    sys.stdout.write("eccode hb populate: %d call(s), %d not accepted%s\n" % (len(notes), len(failed), "".join("\n  " + n for n in failed)))
    sys.stdout.write("eccode hb setup: ok\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
