# Agent roster implementation plan

**Spec:** `docs/specs/2026-10-25-agent-roster.md` (this repo)

**Goal:** Land the fork foundations (F1–F5) as one additive PR on `raviy06/pi-subagents`, then build the roster module (`src/roster/`) in the same repo on top of them.

**Architecture:** All fork changes are additive and feature-detected through `ping.capabilities`. New behaviour lives in small new modules under `src/runs/shared/` wired from `src/extension/index.ts` and `src/extension/rpc.ts`; existing resolvers (`handleList`, `resolveModelSelection`, `buildActivityStatus`) are extended, not replaced. The roster is a self-contained module under `src/roster/` with one wiring block in `src/extension/index.ts`; it calls the catalogue, model-resolution and workflow-resource internals directly and contributes to pi-minimal surfaces over `pi.events` when pi-minimal is loaded.

**Verification (fork):** from a checkout **outside `$HOME`** (e.g. `/tmp/<worktree>`): `npm run typecheck && npm run test:all && npm run build:pkg && npm run check:release -- --packed`. Known flake: `test/unit/global-npm-root.test.ts › terminates the owned npm process on timeout` (500 ms spawn window) — rerun in isolation.

**Branching:** fork work on `ry-roster-foundations` based on `ry-sync-upstream-v0.82.1` (PR #9) so it lands after the sync. Ordinary PR: no version bump; `CHANGELOG.md` `[Unreleased]` only.

---

## Phase 1 — Fork foundations (`~/Dev/src/github.com/raviy06/pi-subagents`)

### Files

**Create**
- `src/runs/shared/activity-change-notifier.ts` — coalesced `subagents:activity:changed` emitter
- `src/runs/shared/run-record-entry.ts` — builds the `subagents:record` payload
- `src/runs/shared/model-candidates.ts` — `[model, ...fallbacks]` → first viable, with reason
- `test/unit/activity-change-notifier.test.ts`
- `test/unit/run-record-entry.test.ts`
- `test/unit/model-candidates.test.ts`

**Modify**
- `src/extension/rpc.ts` — `SUBAGENT_RPC_MANAGEMENT_ACTIONS` += `agents.list|agents.get|models.list`; `pingData` capabilities += `agentsCatalog`, `activityEvents`, `activityStatus.fields`
- `src/agents/agent-management.ts` — `handleList`/`handleGet` return structured `details.entries` (source, filePath, overridden, model, disabled, restricted)
- `src/runs/shared/activity-status-model.ts` — `ActivityEntry` += `task?`, `handle?`, `model?`, `startedAt?`; `ActivityFacts` += `task?`, `requestedModel?`, `effectiveModel?`, `fallbackReason?`
- `src/runs/shared/activity-status-projection.ts` — populate the new fields from `AsyncJobState` / foreground runs
- `src/agents/agents.ts` — parse `agentOverrides.<name>.fallbacks` (string[]), keep the `fallbackModels` error but mention `fallbacks`; `AgentConfig.fallbacks?: string[]`
- `src/agents/frontmatter.ts` — parse `fallbacks:` list
- `src/runs/shared/model-resolution.ts` — `resolveModelSelection` accepts `fallbacks?: string[]` in options; returns `effectiveModel`, `fallbackReason?`
- `src/runs/foreground/execution.ts` (~L1840) — pass `agent.fallbacks` / per-launch `fallbacks`; record `model.{requested,effective,fallbackReason}` on the run
- `src/extension/schemas.ts` — `fallbacks` on launch params (string[], ≤8)
- `src/extension/index.ts` — wire notifier + run-record emission at `session_start`, dispose at `session_shutdown`
- `src/api/shared-types.ts` — export new types
- `docs/extension-api.md`, `docs/models.md`, `docs/fork-maintenance.md`, `CHANGELOG.md`
- `test/unit/rpc.test.ts`, `test/unit/agent-management.test.ts`, `test/unit/activity-status-projection.test.ts`, `test/unit/model-resolution.test.ts`, `test/unit/agent-frontmatter.test.ts`

### Wave 1 — independent modules (pairwise-disjoint files)

#### Task 1: Catalogue over RPC (F1)
- Files: `src/extension/rpc.ts`, `src/agents/agent-management.ts`, `test/unit/rpc.test.ts`, `test/unit/agent-management.test.ts`
- Spec: § F1, AC1
- [ ] Test: `manage` with `action: "agents.list"` over the RPC bus returns `data.entries[]` with `name`, `source`, `disabled`, `overridden`; a builtin with `agentOverrides.<name>.model` set has `overridden: ["model"]`.
- [ ] Test: `ping.capabilities.agentsCatalog` equals `{ version: 1 }`.
- [ ] Add actions to `SUBAGENT_RPC_MANAGEMENT_ACTIONS`; route in `manageParams` → existing handlers with `format: "json"`.
- [ ] Extend `handleList`/`handleGet` `details` with `entries`; keep text output unchanged.
- [ ] Run `node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/rpc.test.ts test/unit/agent-management.test.ts`.
- [ ] Commit `feat(rpc): expose agent catalogue through manage actions`.

#### Task 2: Activity change event (F2)
- Files: `src/runs/shared/activity-change-notifier.ts`, `test/unit/activity-change-notifier.test.ts`
- Spec: § F2, AC2
- [ ] Test: 10 `notify()` calls inside 50 ms → exactly one `subagents:activity:changed` with `revision: 1`; a call after 300 ms → second event `revision: 2`; `dispose()` cancels a pending timer.
- [ ] Implement `createActivityChangeNotifier(emit, { windowMs = 250, now })` returning `{ notify, dispose }`.
- [ ] Commit `feat: coalesced activity change notifier`.

#### Task 3: Run record payload (F3)
- Files: `src/runs/shared/run-record-entry.ts`, `test/unit/run-record-entry.test.ts`
- Spec: § F3, AC3
- [ ] Test: `buildRunRecord(job)` for a completed async job yields `{ version: 1, runId, agent, task (≤200), state: "completed", startedAt, endedAt, durationMs, model: {...}, usage }`; task is truncated with `…`; missing optional facts are omitted, never `null`.
- [ ] Implement pure builder over `AsyncJobState` and the foreground `SingleResult` shape.
- [ ] Commit `feat: run record entry builder`.

#### Task 4: Model candidate resolution (F5, pure part)
- Files: `src/runs/shared/model-candidates.ts`, `test/unit/model-candidates.test.ts`
- Spec: § F5, AC5
- [ ] Test: `pickModelCandidate(["nope/none", "a/b"], available, scopes)` → `{ effective: "a/b", requested: "nope/none", fallbackReason: "unregistered", skipped: [...] }`; all unviable → `null`; primary viable → no reason; out-of-scope primary → `"out-of-scope"`.
- [ ] Implement using the existing `resolveModelCandidate` and `enforceModelScopes` helpers (no provider calls).
- [ ] Commit `feat: resolution-time model candidate selection`.

### Wave 2 — wiring (depends on Wave 1)

#### Task 5: Wire notifier + run records into the extension
- Files: `src/extension/index.ts`, `src/extension/rpc.ts` (capability lines only), `test/integration/result-publication.test.ts`
- [ ] Test (integration): a completed foreground run emits ≥1 `subagents:activity:changed` and exactly one `appendEntry("subagents:record", …)`.
- [ ] Subscribe the notifier to `subagent:child-status`, `subagent:async-started`, `subagent:async-complete`, `subagent:foreground-complete`, `subagent:process-terminal` inside `session_start`; dispose in `session_shutdown`.
- [ ] Call `pi.appendEntry("subagents:record", buildRunRecord(...))` where async results are published (`notify.ts` path) and where foreground results finalise.
- [ ] `pingData`: `activityEvents: { version: 1, event: "subagents:activity:changed" }`.
- [ ] Commit `feat: emit activity change events and durable run records`.

#### Task 6: Richer ActivityEntry (F4)
- Files: `src/runs/shared/activity-status-model.ts`, `src/runs/shared/activity-status-projection.ts`, `src/api/shared-types.ts`, `test/unit/activity-status-projection.test.ts`
- [ ] Test: a running job with `task`, `startedAt`, `requestedModel/effectiveModel` projects `entry.task` (≤120, truncated), `entry.startedAt`, `entry.model`; a 64-entry snapshot still ≤32 KiB.
- [ ] Extend `ActivityFacts`/`ActivityEntry`; populate in projection; `pingData` `activityStatus.fields`.
- [ ] Commit `feat(activity): task, handle, model and startedAt on activity entries`.

#### Task 7: Fallbacks end-to-end (F5)
- Files: `src/agents/agents.ts`, `src/agents/frontmatter.ts`, `src/runs/shared/model-resolution.ts`, `src/runs/foreground/execution.ts`, `src/extension/schemas.ts`, `test/unit/model-resolution.test.ts`, `test/unit/agent-frontmatter.test.ts`
- [ ] Test: `agentOverrides.x.fallbacks: ["a/b"]` parses to `AgentConfig.fallbacks`; `fallbackModels` still throws and the message contains `fallbacks`.
- [ ] Test: frontmatter `fallbacks: [a/b, c/d]` and comma string both parse.
- [ ] Test: `resolveModelSelection("nope/none", available, provider, { fallbacks: ["a/b"] })` → `model: "a/b"`, `requestedModel: "nope/none"`, `fallbackReason: "unregistered"`.
- [ ] Wire `execution.ts` to pass `options.fallbacks ?? agent.fallbacks` and store `model` facts on the run (feeds Task 6 facts and Task 3 record).
- [ ] Commit `feat(models): resolution-time fallbacks with effective-model reporting`.

### Wave 3 — docs and validation (depends on Wave 2)

#### Task 8: Docs + changelog
- Files: `docs/extension-api.md` (catalogue, events, record, ActivityEntry fields), `docs/models.md` (fallbacks section quoting the upstream removal rationale and the resolution-time boundary), `docs/fork-maintenance.md` (bounded-delta list += F1–F5, pointer to the roster spec), `CHANGELOG.md` `[Unreleased]`.
- [ ] Commit `docs: roster foundations`.

#### Task 9: Full validation + PR
- [ ] `git worktree add /tmp/roster-check HEAD && cp -R node_modules /tmp/roster-check/ && (cd /tmp/roster-check && npm run typecheck && npm run test:all && npm run build:pkg && npm run check:release -- --packed)`
- [ ] `python3 ~/.pi/agent/npm/node_modules/@raviy06/pi-agent-activity/scripts/smoke.py --fork /tmp/roster-check/dist-pkg/bundle/index.js --minimal <pi-minimal dist>` (AC7)
- [ ] Draft PR `feat: roster foundations (catalogue RPC, activity events, run records, fallbacks)` against `main`, noting it stacks on #9.

## Phase 2 — Roster module (`src/roster/`, same repo)

Starts after Phase 1 merges. Tasks (to be expanded then):
- R1 `src/roster/settings.ts` — merged `agentRoster` resolver (project over user), schema validation, diff rendering.
- R2 `src/roster/catalog.ts` — catalogue view over `discoverCatalog` with provenance (reuses `AgentCapabilityRow.provenance` from T1).
- R3 `src/roster/assignments.ts` — assignment → `subagents.agentOverrides` projection with confirm-before-write.
- R4 `src/roster/teams/{shapes,compile,register}.ts` — built-in shapes `parallel`, `council`, `pipeline`; user shapes from `~/.pi/agent/workflows/shapes/` and `.pi/workflows/shapes/`; registration as `team.<name>` workflow resources at `session_start`; validator test (AC8).
- R5 `src/roster/ui/roster.ts` — `/roster` command with Agents · Models · Teams · Runs tabs; Runs reuses the activity snapshot and deep-links to `/subagents-fleet`.
- R6 pi-minimal contribution: when pi-minimal's footer contribution API is present, publish roster run rows through it (coordinate with `pi-agent-activity` so only one publisher is active per session) and hide the fork's own widget by default.
- R7 Wiring block in `src/extension/index.ts`; docs (`docs/roster.md`, README section); CHANGELOG.
