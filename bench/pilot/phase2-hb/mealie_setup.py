#!/usr/bin/env python3
"""Setup step of the H-B probe configuration for a Mealie worktree (protocol section 4a, 0.C; detector v3, S1 to S4).

Runs inside the worktree, with the checkout's interpreter, before every probe run:
  1. a fixed SECRET and SESSION_SECRET under DATA_DIR (so tokens are constants),
  2. the database initialized by Mealie's own init_db (alembic head, default group,
     household and admin), exactly as the backend suite starts,
  3. four probe users with FIXED ids in the default group and household, one per role the
     configuration names: user (no permission), admin (all), inviter (can_invite only) and
     organizer (can_organize only); one long-lived API token row per probe user whose token
     column is the constant JWT the configuration generator computed (ECCODE_HB_<ROLE>_TOKEN),
  4. a generic data set a developer would keep in a development database, created through
     Mealie's own API as the admin probe user (and, for the entities the API cannot create,
     through its repositories): foods and units (near-match names, one updated after a newer
     one was created), labels, tools, categories, tags, three recipes with fractional
     quantities, comments, timeline events, meal plan entries and rules, shopping lists with
     items, cookbooks, webhooks, recipe actions, API tokens, an invitation token, share tokens,
     group reports, a second and a third group and household, and three plain users.
     Every call is fail-soft and its HTTP status is printed; nothing here is chosen per change
     under test, and nothing is shaped to a particular seed.
  5. the ids are made the same on every fresh setup (rekey): in every table whose id is a GUID,
     the rows are renumbered in creation order to 00000000-0000-4000-8000-000000000001, ...2, ...3,
     and every foreign key follows; the probe identities keep their reserved ids (...00a0 to
     ...00a4), so the example ids (the first three of every table, the configuration's
     `exampleIds`) never name a user a probe authenticates as and a DELETE probe cannot remove it;
     the probe tokens get integer ids of 1000 and above for the same reason, the other API tokens
     are numbered from 1; the random tokens the application wrote (invitation tokens, API tokens)
     are replaced with constants; the rows of the association tables are put in sorted order (the order a recipe's categories are read
     back in); the random meal plan route has one candidate (a rule without a day or type whose filter names one recipe); the calendar token of the default household is "alpha", the first
     string example of the probe generator, so the public feed answers.
Deterministic by construction: what a probe can observe through the API is either a constant of
this script or something Mealie generates that the engine normalizes (uuids, timestamps); the
census of the noise controls decides whether anything else needs excluding.
"""
import os
import sqlite3
import sys
import uuid
from pathlib import Path

DEFAULT_ADMIN_ID = "00000000-0000-4000-8000-0000000000a0"
# (role, id, username, permission flags). The ids are reserved: the example ids are 00000000-0000-4000-8000-000000000001 to ...3.
PROBES = [
    ("USER", "00000000-0000-4000-8000-0000000000a1", "eccode-probe-user", {}),
    ("ADMIN", "00000000-0000-4000-8000-0000000000a2", "eccode-probe-admin", {"admin": True}),
    ("INVITER", "00000000-0000-4000-8000-0000000000a3", "eccode-probe-inviter", {"can_invite": True}),
    ("ORGANIZER", "00000000-0000-4000-8000-0000000000a4", "eccode-probe-organizer", {"can_organize": True}),
]
SECRET = "eccode-phase2-hb-fixed-secret-2026"
PROBE_TOKEN_BASE = 1000


def populate(admin_token, default_group, default_household):
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

        def make(url, payload):
            b = body(call("POST", url, json=payload))
            return b if isinstance(b, dict) else {}

        me = body(call("GET", "/api/users/self")) or {}
        group_id, household_id = me.get("groupId"), me.get("householdId")
        labels = {n: make("/api/groups/labels", {"name": n, "color": c}) for n, c in (("produce", "#4caf50"), ("pantry", "#ff9800"), ("dairy", "#2196f3"))}
        units = {
            n: make("/api/units", {"name": n, "pluralName": p, "abbreviation": a, "pluralAbbreviation": a, "useAbbreviation": False, "fraction": f, "description": "a unit of measure"})
            for n, p, a, f in (("cup", "cups", "c", True), ("teaspoon", "teaspoons", "tsp", True), ("gram", "grams", "g", False))
        }
        foods = {}
        for n, p, label in (("alpha", "alphas", "produce"), ("alphabet", "alphabets", "pantry"), ("flour", "flours", "pantry"), ("milk", "milks", "dairy"), ("sugar", "sugars", "pantry")):
            foods[n] = make("/api/foods", {"name": n, "pluralName": p, "description": "a food", "labelId": labels[label].get("id")})
        # One food is updated after newer ones were created, so that ordering by update time differs from ordering by creation.
        first = body(call("GET", "/api/foods/%s" % foods["alpha"].get("id"))) if foods["alpha"].get("id") else None
        if isinstance(first, dict):
            first["description"] = "a food, updated after the others were created"
            call("PUT", "/api/foods/%s" % first["id"], json=first)
        organizers = {}
        for kind, names in (("categories", ("alpha", "breakfast", "dessert")), ("tags", ("alpha", "quick", "vegan")), ("tools", ("alpha", "whisk", "oven"))):
            organizers[kind] = [make("/api/organizers/" + kind, {"name": n}) for n in names]

        def ing(quantity, unit, food, note=""):
            return {"quantity": quantity, "unit": units.get(unit) or None, "food": foods.get(food) or None, "note": note}

        recipe_ids = []
        specs = [
            ("alpha", "A generic recipe for probes", 4, [ing(2, "cup", "flour", "sifted"), ing(0.5, "cup", "milk"), ing(0.0625, "teaspoon", "sugar", "a pinch"), ing(1.5, "gram", "alphabet")], 4),
            ("beta", "A second recipe", 2, [ing(1.5, "cup", "milk"), ing(0.03125, "teaspoon", "flour"), ing(3, "gram", "sugar", "to taste")], 3),
            ("gamma", "A third recipe, with a longer description to exercise text fields", 6, [ing(0.25, "cup", "sugar"), ing(10, "gram", "alpha", "diced")], 5),
        ]
        for i, (name, description, servings, ingredients, rating) in enumerate(specs):
            call("POST", "/api/recipes", json={"name": name})
            recipe = body(call("GET", "/api/recipes/" + name))
            if not isinstance(recipe, dict):
                continue
            recipe.update({
                "description": description,
                "recipeServings": servings,
                "prepTime": "%d minutes" % (15 + 5 * i),
                "cookTime": "%d minutes" % (30 + 10 * i),
                "totalTime": "%d minutes" % (45 + 15 * i),
                "rating": rating,
                "orgURL": "https://example.test/recipes/" + name,
                "recipeIngredient": ingredients,
                "recipeInstructions": [{"text": "Mix the dry and the wet ingredients."}, {"text": "Bake until done."}],
                "nutrition": {"calories": str(250 + 50 * i), "fatContent": str(10 + i), "proteinContent": str(5 + i)},
                "recipeCategory": organizers["categories"][: i + 1],
                "tags": organizers["tags"][: i + 1],
                "tools": organizers["tools"][: i + 1],
            })
            call("PUT", "/api/recipes/" + name, json=recipe)
            full = body(call("GET", "/api/recipes/" + name))
            if isinstance(full, dict) and full.get("id"):
                recipe_ids.append(full["id"])
        for i, rid in enumerate(recipe_ids):
            call("POST", "/api/comments", json={"recipeId": rid, "text": "A comment on recipe %d." % (i + 1)})
            call("POST", "/api/recipes/timeline/events", json={"recipeId": rid, "subject": "Made it %d" % (i + 1), "eventType": "info", "eventMessage": "It turned out well.", "timestamp": "2026-01-0%dT10:00:00" % (i + 2)})
            call("POST", "/api/shared/recipes", json={"recipeId": rid, "expiresAt": "2030-01-0%dT00:00:00" % (i + 1)})
        entries = [("2026-01-05", "dinner", "alpha"), ("2026-01-06", "lunch", "beta"), ("2026-01-07", "breakfast", "a note without a recipe")]
        for i, (date, kind, title) in enumerate(entries):
            payload = {"date": date, "entryType": kind, "title": title, "text": "planned"}
            if i < len(recipe_ids):
                payload["recipeId"] = recipe_ids[i]
            call("POST", "/api/households/mealplans", json=payload)
        for day, kind, query_filter in (("monday", "dinner", ""), ("tuesday", "lunch", ""), ("unset", "breakfast", ""), ("unset", "unset", 'name = "gamma"')):
            call("POST", "/api/households/mealplans/rules", json={"day": day, "entryType": kind, "queryFilterString": query_filter})
        for list_name in ("alpha", "weekly", "party"):
            shopping = make("/api/households/shopping/lists", {"name": list_name})
            if shopping.get("id") and list_name == "alpha":
                for note, quantity, checked, food, unit, label in (("milk", 2, False, "milk", "cup", "dairy"), ("flour", 1.5, True, "flour", "gram", "pantry"), ("sugar", 0.25, False, "sugar", "cup", "pantry"), ("fresh herbs", 1, False, None, None, "produce")):
                    call("POST", "/api/households/shopping/items", json={
                        "shoppingListId": shopping["id"], "note": note, "quantity": quantity, "checked": checked,
                        "foodId": foods[food].get("id") if food else None, "unitId": units[unit].get("id") if unit else None, "labelId": labels[label].get("id"),
                    })
            elif shopping.get("id"):
                call("POST", "/api/households/shopping/items", json={"shoppingListId": shopping["id"], "note": "an item of " + list_name, "quantity": 1})
        for name in ("alpha", "desserts", "quick"):
            call("POST", "/api/households/cookbooks", json={"name": name, "description": "a cookbook", "public": name == "alpha"})
        for i, hour in enumerate(("07:00", "12:00", "19:00")):
            call("POST", "/api/households/webhooks", json={"enabled": i != 1, "name": "hook %d" % (i + 1), "url": "https://example.test/hooks/%d" % (i + 1), "webhookType": "mealplan", "scheduledTime": hour})
        for i, kind in enumerate(("link", "post", "link")):
            call("POST", "/api/households/recipe-actions", json={"actionType": kind, "title": "action %d" % (i + 1), "url": "https://example.test/actions/%d" % (i + 1)})
        for name in ("api token one", "api token two", "api token three"):
            call("POST", "/api/users/api-tokens", json={"name": name})
        for uses in (5, 1):
            call("POST", "/api/households/invitations", json={"uses": uses, "groupId": group_id, "householdId": household_id})
        # Second and third group and household, and three plain users (not probe identities, not administrators).
        groups = [make("/api/admin/groups", {"name": n}) for n in ("Second Group", "Third Group")]
        for n, g in (("Second Household", None), ("Third Household", groups[0])):
            call("POST", "/api/admin/households", json={"name": n, "groupId": (g or {}).get("id") or group_id})
        for i, n in enumerate(("member-one", "member-two", "member-three")):
            call("POST", "/api/admin/users", json={
                "username": n, "fullName": "Member %d" % (i + 1), "email": "%s@example.test" % n, "password": "eccode-member-password",
                "authMethod": "Mealie", "admin": False, "group": default_group, "household": default_household,
                "canInvite": False, "canManage": False, "canManageHousehold": False, "canOrganize": False,
            })
    return notes


def make_reports(repos, group_id):
    """Group reports have no create route; they are written by the backup, restore and import jobs. Three, through the repository."""
    from mealie.schema.reports.reports import ReportCategory, ReportCreate, ReportSummaryStatus

    created = 0
    for name, category, status in (
        ("backup 1", ReportCategory.backup, ReportSummaryStatus.success),
        ("import 2", ReportCategory.bulk_import, ReportSummaryStatus.partial),
        ("migration 3", ReportCategory.migration, ReportSummaryStatus.failure),
    ):
        repos.group_reports.create(ReportCreate(category=category, group_id=group_id, name=name, status=status))
        created += 1
    return created


def plain_id(n):
    """The n-th plain id as the 32 hex digits a GUID column stores (uuid4 version and variant bits set)."""
    return "00000000000040008000%012x" % n


def canonical_order(c):
    """Rewrite the rows of every table that has no id (the association tables of the many-to-many relations) in sorted order.

    Which row an association table stores first depends on the order SQLAlchemy flushes a set of objects, which differs from run to run,
    and the order the rows are read back in (a recipe's categories, tags and tools) follows it. Sorted rows read back the same every time.
    """
    for (t,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").fetchall():
        cols = [x[1] for x in c.execute('pragma table_info("%s")' % t)]
        if "id" in cols or t == "alembic_version" or not cols:
            continue
        rows = c.execute('select * from "%s" order by %s' % (t, ", ".join('"%s"' % col for col in cols))).fetchall()
        c.execute('delete from "%s"' % t)
        c.executemany('insert into "%s" values (%s)' % (t, ",".join("?" * len(cols))), rows)


def rekey(db_path, reserved, probe_tokens):
    """Renumber, in every GUID table, the rows in creation order; reserved maps table -> {old stored id: new stored id}."""
    c = sqlite3.connect(db_path)
    c.execute("pragma foreign_keys=OFF")
    tables = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    guid = []
    for t in tables:
        id_col = [x for x in c.execute('pragma table_info("%s")' % t) if x[1] == "id"]
        if id_col and "CHAR(32)" in (id_col[0][2] or "").upper():
            guid.append(t)
    c.execute("create temp table idmap (tbl text, old text, new text)")
    c.execute("create index idmap_i on idmap (tbl, old)")
    for t in guid:
        n = 0
        keep = reserved.get(t, {})
        for (old,) in list(c.execute('select id from "%s" order by rowid' % t)):
            if old in keep:
                new = keep[old]
            else:
                n += 1
                new = plain_id(n)
            c.execute("insert into idmap values (?, ?, ?)", (t, old, new))
    for t in guid:
        c.execute('update "%s" set id = (select new from idmap where tbl = ? and old = "%s".id) where id in (select old from idmap where tbl = ?)' % (t, t), (t, t))
    for t in tables:
        for fk in c.execute('pragma foreign_key_list("%s")' % t).fetchall():
            ref, col, to = fk[2], fk[3], fk[4]
            if ref in guid and to in (None, "id"):
                c.execute('update "%s" set "%s" = (select new from idmap where tbl = ? and old = "%s"."%s") where "%s" in (select old from idmap where tbl = ?)' % (t, col, t, col, col), (ref, ref))
    # Reference ids: columns that hold a GUID but are neither a primary key nor a foreign key (an ingredient or note reference that
    # an instruction points at) are random per ingredient line; they are numbered in order of first appearance, the same everywhere.
    ref_cols = []
    for t in sorted(tables):
        fk_cols = {fk[3] for fk in c.execute('pragma foreign_key_list("%s")' % t).fetchall()}
        for x in c.execute('pragma table_info("%s")' % t).fetchall():
            if "CHAR(32)" in (x[2] or "").upper() and x[1] != "id" and x[1] not in fk_cols and t != "alembic_version":
                ref_cols.append((t, x[1]))
    c.execute("create temp table refmap (old text primary key, new text)")
    n = 0
    for t, col in ref_cols:
        for (old,) in list(c.execute('select "%s" from "%s" order by rowid' % (col, t))):
            if old and len(old) == 32 and c.execute("select 1 from refmap where old = ?", (old,)).fetchone() is None:
                n += 1
                c.execute("insert into refmap values (?, ?)", (old, "00000000000040009000%012x" % n))
    for t, col in ref_cols:
        c.execute('update "%s" set "%s" = (select new from refmap where old = "%s"."%s") where "%s" in (select old from refmap)' % (t, col, t, col, col))
    # Integer-id tables: the probe tokens move out of the small integers a probe sends, the other API tokens start at 1.
    marks = ",".join("?" * len(probe_tokens))
    c.execute("update long_live_tokens set id = id + %d where token in (%s)" % (PROBE_TOKEN_BASE, marks), list(probe_tokens))
    others = [r[0] for r in c.execute("select id from long_live_tokens where id < %d order by rowid" % PROBE_TOKEN_BASE)]
    for n, old in enumerate(others, 1):
        c.execute("update long_live_tokens set id = ?, token = ? where id = ?", (n, "api-token-%d" % n, old))
    c.execute("update invite_tokens set token = 'invite-' || id")
    canonical_order(c)
    c.execute("update household_preferences set mealplan_ical_token = 'alpha' where household_id = (select id from households order by rowid limit 1)")
    c.commit()
    problems = c.execute("pragma foreign_key_check").fetchall()
    c.close()
    return problems


def main():
    data_dir = Path(os.environ["DATA_DIR"])
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in (".secret", ".session_secret"):
        (data_dir / name).write_text(SECRET)
    tokens = {role: os.environ["ECCODE_HB_%s_TOKEN" % role] for role, *_ in PROBES}

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
        group = repos.groups.get_by_name(settings.DEFAULT_GROUP)
        assert group is not None, "default group missing after init_db"
        for role, uid, username, flags in PROBES:
            if repos.users.get_one(uid, "id", any_case=False) is None:
                repos.users.create({
                    "id": uid,
                    "username": username,
                    "full_name": username,
                    "email": f"{username}@example.test",
                    "password": hash_password("eccode-probe-password"),
                    "group": settings.DEFAULT_GROUP,
                    "household": settings.DEFAULT_HOUSEHOLD,
                    "admin": bool(flags.get("admin")),
                    "can_invite": bool(flags.get("admin") or flags.get("can_invite")),
                    "can_manage": bool(flags.get("admin")),
                    "can_manage_household": bool(flags.get("admin")),
                    "can_organize": bool(flags.get("admin") or flags.get("can_organize")),
                })
            existing = repos.api_tokens.multi_query({"token": tokens[role], "user_id": uid})
            if not existing:
                repos.api_tokens.create(CreateToken(name="eccode-hb", user_id=uid, token=tokens[role]))
        reports = make_reports(repos, group.id)
    notes = populate(tokens["ADMIN"], settings.DEFAULT_GROUP, settings.DEFAULT_HOUSEHOLD)
    failed = [n for n in notes if not n.rsplit(" ", 1)[-1].isdigit() or int(n.rsplit(" ", 1)[-1]) >= 300]
    sys.stdout.write("eccode hb populate: %d call(s), %d not accepted%s\n" % (len(notes), len(failed), "".join("\n  " + n for n in failed)))

    db_path = str(data_dir / "mealie.db")
    conn = sqlite3.connect(db_path)
    probe_hex = {uuid.UUID(uid).hex for _, uid, _, _ in PROBES}
    default_row = conn.execute("select id from users where id not in (%s) order by rowid limit 1" % ",".join("?" * len(probe_hex)), list(probe_hex)).fetchone()
    conn.close()
    reserved = {"users": {h: h for h in probe_hex}}
    if default_row:
        reserved["users"][default_row[0]] = uuid.UUID(DEFAULT_ADMIN_ID).hex
    problems = rekey(db_path, reserved, list(tokens.values()))
    sys.stdout.write("eccode hb rekey: %d foreign-key problem(s); %d group report(s)\n" % (len(problems), reports))
    if problems:
        sys.stderr.write("rekey left foreign-key problems: %r\n" % (problems[:5],))
        return 1
    sys.stdout.write("eccode hb setup: ok\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
