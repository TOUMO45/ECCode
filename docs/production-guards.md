# Production guards (Phase 3, Part B)

A change that touches a production-sensitive surface carries machine-checked safety evidence before it is delivered. `eccode guard route` records which guards the change needs (from `impact` and the change's surfaces); each must run on the current tree before the last gate, and delivery refuses a required guard that has not run, a blocking finding no reviewer waived, a failed rollback proof, a regression, a new N+1 or a broken concurrency invariant. `quick` skips every guard. Python/FastAPI and Alembic/SQLAlchemy first.

```
eccode guard route --actor backend-engineer
eccode guard migration --actor backend-engineer            # static analysis of the change's migrations
eccode guard migration --proof --actor backend-engineer    # seed a db, upgrade -> downgrade -> upgrade, compare the schema
eccode guard api --actor backend-engineer                  # OpenAPI + Python signatures, baseline vs candidate
eccode guard perf --actor backend-engineer                 # micro-benchmark of the change's routes, with query counts
eccode guard race --actor backend-engineer                 # the configured operations under concurrency
eccode guard release --strategy flag --flag <name> --monitoring "…" --rollback "…" --actor delivery-lead
eccode guard release ack <id> --actor technical-reviewer
eccode guard waive --guard <g> --result <id> --finding <f> --reason "…" --actor technical-reviewer
```

## B.1 Migration safety (`lib/guards/migration.js`)
Static analysis of every migration file the change adds or edits: a NOT NULL column without a `server_default`, a type change, a rename in place, an index without `postgresql_concurrently`, a table rename, destructive SQL, a drop of a column or table, and a missing or empty `downgrade()` (blocking); an applied migration that was edited or deleted (blocking). The expand/contract rule flags a rename or type change done in one step. The **rollback proof** (when `.eccode/guards.json` "migration" gives the seed/upgrade/downgrade commands and a database env) seeds a database in the candidate worktree, dumps the schema, downgrades one step, upgrades again, and compares: the schema must round-trip.

## B.2 API compatibility (`lib/guards/api.js`)
The app's OpenAPI schema (when `.eccode/behavior.json` names the app) and the signatures of the changed Python functions, in both worktrees, classified: **breaking** (an endpoint or field removed, a type changed, a parameter made required, a function or its parameter removed), **additive**, or **none**. A breaking change must be declared in the design decision's interfaces and in the behavior contract, or a reviewer waives it; the old rule is now machine-detected, not agent-declared.

## B.3 Performance budget (`lib/guards/perf.js`)
The change's routes (or the probes `.eccode/guards.json` configures) run as a micro-benchmark in both worktrees: warmup, N repetitions, median and interquartile range, and the number of SQL statements one request executes (SQLAlchemy `before_cursor_execute`). A latency regression beyond the threshold (default 20%, and above a small absolute floor) or a new N+1 (the query count grew) refuses delivery unless the reviewer waives it with a rationale.

## B.4 Concurrency (`lib/guards/race.js`)
The operations `.eccode/guards.json` "race" declares (a request, its concurrency and repeat, and invariants as SQL: a conserved sum, an exact count, a maximum) run concurrently against a seeded database in both worktrees; an invariant the candidate breaks (a double-spend, a duplicate insert, a lost update) refuses delivery. Required when the change touches the configured watch paths.

## B.5 Release plan (`lib/guards/release.js`)
`feature` and `greenfield` deliveries carry a `release.plan` (a feature flag or staged rollout, the monitoring signal, the rollback step) acknowledged by a reviewer. Report-only beyond presence and acknowledgement.

## Evidence and audit
Every guard writes a content-hashed artifact under `.eccode/guards/`; `eccode audit` re-hashes them. Every probe runs through the evidence integrity window with the network closed. Delivery and the last gate call `guards.deliveryProblems`.

## Limits
- FastAPI, SQLAlchemy and Alembic only (Python first; the interfaces are designed for other stacks later).
- The OpenAPI diff needs a configured app; without one, only Python signatures are compared.
- The micro-benchmark is wall-clock on the benchmark machine with warmup and a median; it catches gross regressions and N+1, not microsecond drift.
- The race probe finds a race only when the declared invariant and the concurrency provoke it; absence of a flag is not proof of safety.
- A guard that cannot run (no app, no migration commands) is reported as not run, never passed silently.
