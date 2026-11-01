# Security as a capability (Phase 3, Part C)

Before a change that touches routes, authentication, permissions or ownership
is delivered, ECCode runs the standard access-control test battery against the
project's **own** FastAPI app — the same checks a CI suite runs. The app is
imported into an isolated candidate worktree, the network is closed (every
socket connection to anything but loopback raises, exactly as the behavior
diff's probe runner does), and every request goes to the app under test through
FastAPI's `TestClient`. Nothing targets a third party: an SSRF input probe, for
example, checks whether the app *accepts* an internal URL, it never fetches one.

A change that breaks access control — a route that stops enforcing ownership, a
role that gains an endpoint it should not reach — is caught here, before
delivery, rather than in production.

## The four probe kinds

All four run in the candidate worktree (HEAD plus the working tree's changes)
through `scripts/guards/access_probe.py`, which imports the app, closes the
network, reads the OpenAPI schema for example path/query/body values, and reads
the role headers from the configuration.

### 1. Access matrix (`security.matrix.result`)

For every configured role × endpoint × ownership, the guard sends the request
with that role's headers against an object the role **owns**, an object
**another** role owns, or **none** (a non-existent id / no object), and compares
the HTTP outcome to the declared policy:

- **allow** = a 2xx response.
- **deny** = 401, 403, 404 or 405.

A cell whose observed outcome disagrees with the declared `expected` is an
**unexplained** failure. A cell for which no policy is declared is **unknown**.
The result records `{cells: [{role, endpoint, ownership, expected, observed,
status, match}], unexplained, unknown, artifact, artifactSha256}`.

### 2. IDOR / BOLA (`security.idor.result`)

For every endpoint that addresses an object by id (from `objects`), the guard
creates/lists objects as role A, then accesses them as role B of the **same**
role level (a peer), as a **lower** role, and **unauthenticated**. A probe
**fails** when a non-owner receives a 2xx response, or sees fields that belong
to A (the non-owner's body is compared field by field to A's own fetch; matching
fields are reported as `leaked`). The result records `{probes: [{endpoint, as,
ownerRole, status, leaked, fail}], unexplained, artifact, artifactSha256}`; the
artifact holds the full request/response pairs. A higher-privilege role is not
probed (it legitimately sees more).

### 3. Auth flows (`security.authflow.result`)

Executed checks declared in `authFlows`:

- a token works, then **logout invalidates it** (a later request is 401/403);
- a password-reset token is **single-use** (a second confirm is 4xx);
- where configured, token expiry and OAuth state.

The result records `{checks: [{name, kind, passed, detail}], flagged}`.

### 4. Input probes (`security.input.result`)

Targeted checks on the changed endpoints — **not** a scanner. For each
configured input the guard sends one crafted value and records the
request/response pair, flagging the probe when the payload took effect:

- `sql` — a SQL metacharacter string; flagged on a 500 carrying a SQL error.
- `path-traversal` — `../` into a file/path param; flagged when the target's
  content comes back.
- `ssrf` — a loopback/metadata URL into a URL param; flagged when the app
  *accepts* it (2xx). The network stays closed; no request leaves the app.
- `template` — a template-injection string where templates render input;
  flagged when the expression is evaluated.

The result records `{probes: [{endpoint, param, in, kind, payload, status,
flagged, evidence}], flagged}`.

## Configuration: `.eccode/security.json`

```jsonc
{
  // Optional: overrides the roles in .eccode/behavior.json. Each role has a
  // name, the request headers that authenticate it, and a privilege level
  // (0 = unauthenticated; peers share a level; higher levels see more).
  "roles": [
    { "name": "member-a", "level": 1, "headers": { "Authorization": "Bearer tok-a" } },
    { "name": "member-b", "level": 1, "headers": { "Authorization": "Bearer tok-b" } },
    { "name": "admin",    "level": 2, "headers": { "Authorization": "Bearer tok-admin" } },
    { "name": "anonymous","level": 0, "headers": {} }
  ],

  // The objects the IDOR/BOLA probes create, list and fetch. The item endpoint
  // defaults to "<list.path>/{idParam}"; set `item: {method, path}` to override.
  "objects": [
    {
      "kind": "note",
      "idParam": "note_id",
      "list":   { "method": "GET",  "path": "/notes", "itemsField": "items", "idField": "id" },
      "create": { "method": "POST", "path": "/notes", "json": { "text": "…" }, "idField": "id" }
    }
  ],

  // The declared access policy. Each cell is role × endpoint × ownership ->
  // allow|deny. Committed cells (eccode security policy) win over these.
  "policy": [
    { "role": "member-a", "endpoint": "GET /notes/{note_id}", "ownership": "own",   "expected": "allow" },
    { "role": "member-a", "endpoint": "GET /notes/{note_id}", "ownership": "other", "expected": "deny"  },
    { "role": "member-a", "endpoint": "GET /admin/stats",     "ownership": "none",  "expected": "deny"  }
  ],

  // Auth-flow checks. Any section may be omitted.
  "authFlows": {
    "login":  { "path": "/login", "json": { "user": "…", "password": "…" }, "tokenField": "token" },
    "verify": { "path": "/me" },
    "logout": { "path": "/logout" },
    "reset":  {
      "request": { "path": "/reset",         "json": { "email": "…" }, "tokenField": "token" },
      "confirm": { "path": "/reset/confirm", "jsonTemplate": { "token": "{token}", "password": "new" } }
    }
  },

  // Targeted input probes on specific endpoints.
  "inputs": [
    { "endpoint": "GET /search", "param": "q", "in": "query", "kind": "sql" }
  ]
}
```

The app import path (`"app": "<module>:<attr>"`), the default roles, and the
probe environment (`env`, `setup`) come from `.eccode/behavior.json`, the same
as the behavior diff and the other Phase 3 guards. Both config files travel with
the worktree; neither is part of the event record.

## The delivery gate

The guard is **required** when the change touches access control — any changed
non-test code file whose path or content matches auth/permission/role/owner/
login/token/session, any HTTP surface the change reaches, or a changed model
with an ownership field — **and** the capability is configured (an app plus
objects or a policy). `quick` work items skip every guard.

When the guard is required, delivery (and the last gate) refuses unless, at the
current tree fingerprint:

- a fresh **access matrix** result exists with **zero unexplained** failures;
- a fresh **IDOR** result exists with **zero** flagged probes;
- every endpoint with an **unknown** matrix cell is covered by a reviewed
  `security.policy` — a new endpoint needs a reviewed policy before it ships
  (declaring the policy is not safe-by-default: an undeclared cell is *unknown*,
  not *allowed*);
- no auth-flow check and no input probe is flagged.

Auth-flow and input results are always reported; they block only on a flagged
failure. Any single finding can be waived by a reviewer with a rationale, reusing
the guard waiver mechanism:

```
eccode guard waive --guard security --result <result id> --finding "<finding>" --reason "…"
```

where the finding is `"<role> <endpoint> <ownership>"` for a matrix cell,
`"<endpoint> as <role>"` for an IDOR probe, the check name for an auth flow, or
`"<endpoint> <param> <kind>"` for an input probe.

## Commands

```
eccode security policy    --actor security-reviewer --file policy.json   # declare role × endpoint × ownership cells
eccode security matrix    --actor <owner>                                # build the access matrix
eccode security idor      --actor <owner>                                # run the IDOR/BOLA probes
eccode security authflow  --actor <owner>                                # run the auth-flow checks
eccode security input     --actor <owner>                                # run the targeted input probes
```

`policy` may be recorded only by a security reviewer or the technical designer.

## Limits

- **FastAPI only.** The probes import the app and drive it through FastAPI's
  `TestClient`; another framework is out of scope.
- **Generated example inputs.** Path, query and body values come from the
  OpenAPI schema's examples, not from an exhaustive attack corpus. The probes
  exercise the access decision, not every possible payload.
- **The input probes are targeted checks, not a scanner.** They send one crafted
  value per configured input and look for a specific effect; they do not crawl
  the app or fuzz every parameter.
- **An `unknown` cell means the policy is undeclared, not safe.** A new endpoint
  with no declared policy refuses delivery until a reviewer declares one.
- **The network is closed.** No probe reaches an external host; an SSRF probe
  verifies the app's own allow/deny decision.
