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
the role headers from the configuration. Each probe is an executed
request/response pair with an **oracle** that judges it: a status, a field set,
a read-back, a differential. The artifact keeps every pair.

### 1. Access matrix (`security.matrix.result`)

For every configured role × endpoint × ownership, the guard sends the request
with that role's headers against an object the role **owns**, an object
**another** role owns (a peer's when one exists), or **none** (a non-existent
id / no object), and compares the HTTP outcome to the declared policy:

- **allow** = a 2xx response.
- **deny** = 401, 403, 404 or 405.

The request is otherwise valid: query and body come from the OpenAPI schema of
the template path (a `PATCH /accounts/{id}` carries its required body, so the
ownership check is reached, not a 422 before it), and string values carry the
role's name so two principals never write the same value into a unique column.
Reads run first, then writes, deletes last, so a destructive cell cannot hide
what an earlier read would have shown.

**Field-leak oracle.** A 2xx on another principal's object, seen by a role at
or below the owner's level, is also judged by its fields: the body is diffed
against the owner's own fetch of the same object and against the **field
policy** (`fields` in `security.json`, an allow-list per endpoint and,
optionally, per role). A field of the owner's object that the policy does not
allow is **leaked**; a sensitive field (`password`, `hash`, `secret`, `token`,
`email`, …) is leaked whether or not a policy is declared, unless the policy
allows it by name. A field no policy covers is **unknown**: reported and
refused like an undeclared cell, never silently allowed. When no policy is
declared for the endpoint, the OpenAPI response schema's declared properties
are the default allow-list for a non-owner (minus the sensitive ones); an app
that declares no `response_model` allows nothing by default. The owner and a
higher-privilege role see everything.

A cell whose observed outcome disagrees with the declared `expected`, or that
leaks a field, is an **unexplained** failure. A cell for which no policy is
declared is **unknown**. The result records `{cells: [{role, endpoint,
ownership, expected, observed, status, match, leaked, unknownFields,
ownerRole}], unexplained, unknown, unknownFields, artifact, artifactSha256}`;
the artifact holds each cell's request, response and, for a field check, the
owner's response.

### 2. IDOR / BOLA and property-level writes (`security.idor.result`)

**Reads.** For every object endpoint the change reaches (from `objects`; a route
declared without its router's mount prefix still matches), the guard obtains one
object per authenticated role — created through `create`, or the seeded id
`owned` names for an object the API does not create (a user, a tenant) — then
fetches each role A's object as role B of the **same** level (a peer), as a
**lower** role, and **unauthenticated**. A higher-privilege role is not probed
(it legitimately sees more). The non-owner's body is compared field by field to
A's own fetch:

- with no field policy for the endpoint, the object is private: any 2xx to a
  non-owner **fails**, and every field that matches A's is reported `leaked`;
- with a field policy, a 2xx is legitimate as long as only the allowed fields
  come back (a public profile); a field of A's outside the allow-list, or a
  sensitive one, is `leaked` and the probe **fails**; fields the policy does
  not cover are `unknownFields`.

**Mass assignment.** For every write endpoint of each object (`writes` as
declared, else the `create` endpoint and every PUT/PATCH the OpenAPI schema
declares on the item path), the guard sends, as each owner, the legitimate body
**plus** privileged fields: a fixed list (`role`, `is_admin`, `admin`,
`is_staff`, `is_superuser`, `verified`, `is_verified`, `owner_id`, `user_id`,
`balance`), every `*_id` the object exposes, the write schema's own privileged
or `*_id` properties, and whatever `inject` declares. Each value is chosen to
differ from the object's current one and is typed as the request schema
declares the field. The guard then reads the object back (`readBack`, default
the item endpoint; the write's own response when the read-back no longer answers
the writer) and **fails** the probe on every injected field that persisted. A
4xx on the write (the field rejected) passes. These probes run last, so an
injected privilege that sticks cannot colour the reads.

The result records `{probes: [{kind: read|mass-assignment, endpoint, as,
relationship, ownerRole, status, leaked, unknownFields, injected, persisted,
fail}], unexplained, artifact, artifactSha256}`; the artifact holds the full
request/response pairs, the owner's response, the state before the write and
the read-back.

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

- `sql` — two oracles. The error oracle: a SQL metacharacter string, flagged on
  a 500 carrying a SQL error. The **boolean differential**: a value no row
  matches (`eccodeprobe`) followed by a true condition (`' OR '1'='1`) and by a
  false one (`' AND '1'='2`), each with and without a trailing `--`; a
  parameterized query treats both literally and answers the same, an injected
  one tells them apart. Flagged when the tautology answers a different status,
  more rows (the length of a list body, else of its largest list value), or,
  when no row count can be read, a different body once the echoed payloads are
  removed. An injection that returns a clean 200 is caught this way; the
  request/response pairs of both conditions are the evidence (`differential`).
- `path-traversal` — `../` into a file/path param; flagged when the target's
  content comes back.
- `ssrf` — a loopback/metadata URL into a URL param; flagged when the app
  *accepts* it (2xx). The network stays closed; no request leaves the app.
- `template` — a template-injection string where templates render input;
  flagged when the expression is evaluated.

The result records `{probes: [{endpoint, param, in, kind, payload, status,
flagged, evidence, differential}], flagged}`.

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

  // The objects the IDOR/BOLA probes obtain, fetch and write. The item endpoint
  // defaults to "<list.path>/{idParam}"; set `item: {method, path}` to override.
  // An object the API does not create (a user, a tenant) names the seeded id
  // each role owns in `owned`. `writes` lists the endpoints the mass-assignment
  // probe exercises (default: `create` plus every PUT/PATCH on the item path),
  // `readBack` where it reads the object back (default: `item`), `inject` fixes
  // the value of a privileged field (default: a value that differs from the
  // current one, typed as the write schema declares it).
  "objects": [
    {
      "kind": "note",
      "idParam": "note_id",
      "list":   { "method": "GET",  "path": "/notes", "itemsField": "items", "idField": "id" },
      "create": { "method": "POST", "path": "/notes", "json": { "text": "…" }, "idField": "id" }
    },
    {
      "kind": "user",
      "idParam": "user_id",
      "item":     { "method": "GET",   "path": "/users/{user_id}" },
      "owned":    { "member-a": 2, "member-b": 4, "admin": 1 },
      "writes":   [{ "method": "PATCH", "path": "/users/{user_id}" }],
      "readBack": { "method": "GET",   "path": "/users/{user_id}" },
      "inject":   { "role": "admin" }
    }
  ],

  // The field policy: the fields a NON-OWNER may see on an endpoint (optionally
  // only for the listed roles). Anything else of the owner's that comes back is
  // a leak; a field the policy does not cover is unknown, never silently
  // allowed. The owner and a higher-privilege role see everything. Without an
  // entry, the endpoint's OpenAPI response schema (minus sensitive fields) is
  // the default allow-list, and an object with no policy is private to its
  // owner (any 2xx to a non-owner is an IDOR).
  "fields": [
    { "endpoint": "GET /users/{user_id}", "allow": ["id", "username", "role"] },
    { "endpoint": "GET /users/{user_id}", "roles": ["support"], "allow": ["id", "username", "role", "email"] }
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

- a fresh **access matrix** result exists with **zero unexplained** failures
  (no cell disagrees with the policy, no cell leaks a field);
- a fresh **IDOR** result exists with **zero** flagged probes (no non-owner
  read, no persisted injected field);
- every endpoint with an **unknown** matrix cell is covered by a reviewed
  `security.policy`, and every field a non-owner sees that no field policy
  covers gets a reviewed `fields` entry — a new endpoint needs a reviewed
  policy before it ships (declaring the policy is not safe-by-default: an
  undeclared cell is *unknown*, not *allowed*, and so is an undeclared field);
- no auth-flow check and no input probe is flagged.

Auth-flow and input results are always reported; they block only on a flagged
failure. Any single finding can be waived by a reviewer with a rationale, reusing
the guard waiver mechanism:

```
eccode guard waive --guard security --result <result id> --finding "<finding>" --reason "…"
```

where the finding is `"<role> <endpoint> <ownership>"` for a matrix cell (its
status, its leaked fields and its unknown fields alike), `"<endpoint> as
<role>"` for an IDOR read or mass-assignment probe, the check name for an auth
flow, or `"<endpoint> <param> <kind>"` for an input probe.

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
- **The input probes are targeted checks, not a scanner.** They send a handful
  of crafted values per configured input and look for a specific effect; they
  do not crawl the app or fuzz every parameter. The SQL differential reads row
  counts from list bodies; an endpoint that returns a scalar or a page without
  a list is compared by body text, where an unrelated difference (a timestamp)
  would flag it, and a reviewer waives it.
- **The field oracle sees what the owner sees.** A field is the owner's when the
  owner's own fetch carries the same key and value; a value the app derives for
  the viewer is reported unknown, not leaked. A sensitive name (`email`,
  `*hash*`, `*token*`, …) is judged by its name.
- **The mass-assignment probe knows a fixed vocabulary** (`role`, `is_admin`,
  `owner_id`, `*_id`, `balance`, …) plus what `inject` declares; a privileged
  field under another name needs an `inject` entry. It writes to the app under
  test (an injected value that sticks changes that worktree's data), which is
  why it runs last and never against anything but the candidate worktree.
- **A destructive cell changes the data the later cells see.** Deletes run
  last; under a real IDOR-on-delete flaw a victim's later `own` cell can report
  a knock-on 404 beside the flaw itself.
- **An `unknown` cell or field means the policy is undeclared, not safe.** A new
  endpoint with no declared policy, or a field a non-owner sees that no field
  policy covers, refuses delivery until a reviewer declares one.
- **The network is closed.** No probe reaches an external host; an SSRF probe
  verifies the app's own allow/deny decision.
