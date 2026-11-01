# Observed team standards

Phase 3, part E. ECCode reads what a project already does, from its git history and from its source and configuration files, and turns it into a short list of **observed** standards: how commits are written, how things are named, where tests live, how errors are handled, and which rules the project's own linters state. The list is shown to the agent at onboarding and stored in project memory.

Nothing in it is enforced. Every entry is labelled `observed`; none says "must"; no gate checks any of them. This phase is report-only.

## What is observed, and how

`lib/standards.js` runs five deterministic extractors over the repository. The only processes it spawns are `git log -n <limit> --format=%s` and the `git ls-files` listing the codebase index already uses. Nothing goes over the network.

| Kind | Read from | What is reported |
|---|---|---|
| `commit-message` | the last `limit` commit subjects (default 400) | the dominant form (conventional commits `type(scope): summary`, a `Topic: summary` prefix, or plain summaries) with the types seen; the subject length at the 90th percentile; imperative mood (a first-word heuristic); capitalisation after the prefix; a ticket id pattern (`ABC-123`, `#42`) when 30% or more of subjects carry one |
| `naming` | Python and JS/TS files (regex over masked code, so strings and comments do not count) | the dominant function-name style (snake_case vs camelCase) per language, class-name style, file-name style (kebab, snake, camel) per language, the `test_` prefix of Python test functions, `test()` vs `it()` in JS/TS test files. Single-word names give no evidence either way and are left out of the share |
| `test-layout` | file paths, `pyproject.toml`, `pytest.ini`, `setup.cfg`, `tox.ini`, `package.json` | where tests live (`tests/` at the root, `__tests__/` beside the source, or next to the source files), the test-file naming pattern (`test_<module>.py`, `<name>.test.js`, …), the runner stated in configuration (pytest, vitest, jest, mocha, ava, tap, `node --test`), fixture directories and `conftest.py` files |
| `error-handling` | Python and JS/TS files | custom exception classes (`*Error`, `*Exception`) and the base most of them derive from; how often `except Exception` / bare `except` appears among except clauses, and how many silently `pass`; whether errors are raised or logged (`raise` vs `logger.error/exception/warning`; `throw` vs `console.error`); `raise HTTPException(...)` for FastAPI, as a share of the raise statements in the files that use it; which class JS/TS code throws (`throw new EccodeError(...)` style); empty `catch` blocks; result-object returns (`return { ok: … }`) |
| `forbidden-pattern` | configuration files the project already has | one rule per file: ruff `select`/`ignore`/`line-length` (`pyproject.toml [tool.ruff]`, `[tool.ruff.lint]`, `ruff.toml`), mypy strictness flags (`[tool.mypy]`, `mypy.ini`), flake8 (`.flake8`, `setup.cfg`, `tox.ini`), eslint (`.eslintrc*`, `eslint.config.*`: `extends` and the rules at error level), biome (`biome.json`), pre-commit hook ids (`.pre-commit-config.yaml`), EditorConfig settings for `[*]` (`.editorconfig`) |

Every observed rule is one object:

```json
{
  "kind": "commit-message",
  "rule": "Commit subjects follow the conventional-commits form \"type: summary\" in 92% of the last 13 commits; types seen: feat (6), fix (6); 33% of them carry a (scope).",
  "confidence": 0.923,
  "examples": ["fix: conftest fixtures", "feat: eslint configuration", "fix: ruff configuration"],
  "source": "git-history"
}
```

- `rule` is one sentence a human would write. It describes; it never says "must".
- `confidence` is the share of the evidence that agrees with the rule (12 of 13 commits → 0.923), or `1` for a rule the project states itself in a configuration file.
- `examples` are up to three short strings from the evidence.
- `source` is `git-history`, `source-files`, or the path of the configuration file the rule was read from.

`extract()` also returns `scanned`: how many commits, files, Python and JS/TS files, test files and config files it read, and how many files it skipped beyond its 3000-file limit.

## Observed, not enforced

The brief says it, the record says it, and the code keeps it:

- The onboarding section is titled **"Observed project standards (not enforced)"**, one line per rule with its confidence and source, and ends with a note that the list is evidence about the project, not instructions.
- The memory record is a **project-layer** record. Project-layer records are `recorded`, never `provisional` or `verified`; `verificationGaps()` says they are not reviewed; `promote()` refuses them. That is the existing rule for project memory, and observed standards inherit it: they never reach shared memory and no review can turn them into a lesson.
- No gate reads the record. A task that writes `catch {}` in a project where catch blocks are usually non-empty completes exactly as before. If a later phase wants to act on an observed standard, that will be a separate decision with its own gate rule, not a side effect of this one.

### The memory record

`record(store, config, actor, observed)` writes one record through `Memory.add()` with `layer: 'project'`, so it lands in `.eccode/memory/records/<id>.json` with a `memory.recorded` event in the project's hash-chained log. The body lists every rule as `- observed: [kind] rule (confidence, source) e.g. …` and states the method and its limits.

The project memory schema (`schemas/memory-project.schema.json`) allows `kind` to be one of `requirement`, `architecture`, `decision`, `constraint`, `interface`, `dependency`, `progress`. It does not yet allow `standard`, and this part does not edit the schema. Until it does, the record is stored with `kind: "constraint"` and the tag `observed-standard` (plus one tag per kind observed) as the marker. `recordKind()` reads the schema's enum at run time: once `standard` is added to it, new records use `kind: "standard"` with no other change. Adding `standard` to the enum is the one schema change this feature would want.

## Limits

- **No PR review comments.** The brief asks for review comments "where available via API". ECCode has no network access and no hosting-provider client, so they are not available here; the extractor reads only what the repository holds: commit subjects, source files and configuration. A project whose conventions live in review threads rather than in commits or configuration will show lower confidences, not invented rules.
- **Regex heuristics, not parsers.** Code is masked (strings and comments blanked) before counting, but names, except clauses and throws are matched by pattern. Nested definitions, generated code and unusual formatting can be missed or miscounted. Imperative mood is a first-word heuristic with a short stop list; a subject that begins with a noun still passes it.
- **Counts, not semantics.** "Python errors are raised rather than logged: 66 raise statements vs 0 logger calls" is a count. It does not know which raises are re-raises, which logs are debugging leftovers, or whether the team would agree with the sentence. That is why the confidence is a share and the examples are listed.
- **Thresholds.** A rule needs at least three pieces of evidence; a format rule needs 50% agreement to be named; the imperative and capitalisation rules need 60%; a ticket-id pattern needs 30%. Below that the extractor stays silent rather than guessing.
- **Scope.** The scan reads up to 3000 Python and JS/TS files (the rest are counted as `scanned.unscanned`) and files up to 512 KB. Other languages contribute to test layout (by path) only.
- **History only as it exists locally.** A shallow clone shows fewer commits; `scanned.commits` reports how many were read.

## Commands (wired by the CLI and the onboarding brief)

```
eccode standards show       # the observed list, grouped by kind, with confidence and source
eccode standards extract    # the same, and one project-memory record of kind constraint + tag observed-standard
eccode onboard              # the codebase brief ends with "## Observed project standards (not enforced)"
```

`show(root)` renders the text, `extract(root, { limit })` returns the data, `brief(observed)` returns the Markdown section for `onboardBrief`, and `record(store, config, actor, observed)` stores it and returns the record id. `record()` refuses an empty list (`NOTHING_OBSERVED`) rather than writing an empty record.
