# Agent roster: user-owned agent, model and team management for pi-subagents

**Status:** approved (design agreed in session 2026-10-25)
**Owner:** raviy06
**Repos:** `raviy06/pi-subagents` (fork: execution, control plane **and roster**), `raviy06/pi-agent-activity` (read-only pi-minimal footer bridge), `pi-minimal` (host environment)

## Problem

pi-subagents (nicobailon fork) already has the engine: scripted workflows, retained children, missions, external runners, remote placement, and a versioned in-process RPC. What it lacks is a *product layer* the user controls:

- Agent management is spread over ~20 slash commands and tool actions (`list`, `eject`, `disable`); there is no one place to see every agent, where it came from, and what model it runs on.
- Models are assigned one string per agent (`subagents.agentOverrides.<name>.model`). There is no primary → fallback policy, so a shared config breaks the moment a provider or model is missing on one machine.
- There is no first-class notion of a **team** (a named, reusable set of agents with a shape such as parallel review or chair-led council). The only council today is a filename convention (`council-*`) in a skill, and pi-gauntlet's `specCouncil.members` is a list of *models* wired to one gauntlet phase.
- Observability consumers (pi-agent-activity) poll `status` every 2 s and cannot show *what* a child is doing, because `ActivityEntry` carries no task text, handle or effective model.

pi-gauntlet is deliberately opinionated. The roster is the opposite: a general, customizable layer where the **user decides** how agents, models and workflows combine; extensions only provide and manage.

## Goals

1. One hub (`/roster`) to see, assign, group and launch agents, with every write expressed as a visible pi-settings diff.
2. Model policy per agent: primary + ordered fallbacks, resolved at launch; the effective model and reason are observable.
3. Teams as data: named member sets + a shape, compiled to fork workflow resources, invokable by the model (`subagent({ workflow: "team.<name>" })`), by skills, and later by `@mention`.
4. Fork foundations that *any* consumer (activity footer, roster, gauntlet telemetry, future mentions/CC-workflow shim) can build on without polling or private imports.
5. Keep the fork delta bounded and upstream-shaped: additive fields, additive RPC actions, additive events.

## Non-goals

- A second workflow engine or a Claude Code `Workflow` shim (separate later project; it compiles onto fork `runs.*`).
- Same-launch model switching (upstream removed `fallbackModels` and 429 continuation deliberately; v1 fallback is resolution-time only).
- Auto-delegation, auto team selection, or any extension deciding *for* the user.
- Replacing pi-gauntlet. Gauntlet may later *read* a roster team; it is not changed here.

## Principles (user authority)

1. Extensions provide and manage; they never decide. No auto-delegation, no team auto-selection, no silent rewrites of agent files.
2. Everything is data in pi settings or files in the user's directories. The UI is a convenience over `settings.json`, never the only path.
3. Shapes, agents and workflows are user-extensible by dropping files. Built-ins are examples, not privileged.
4. Project settings may narrow (scope, disable); the user can always see and eject.

## Design

### Layering

```
host        pi-minimal: the personal agentic environment. Owns the surfaces users customize
            (footer slots, plan bar, chrome, future panels) and versioned contribution APIs.
            Knows nothing about subagents.
process     pi-gauntlet (phases, gates, specs, telemetry)                     — unchanged
provider    pi-subagents fork — ONE extension:
              roster     src/roster/**: catalogue, assignments, teams, /roster UI
              control    RPC: ping/capabilities · status · manage · spawn/steer/stop · cost · events
              execution  runs.*, missions, retained children, runners, placement
bridge      pi-agent-activity: fork activity snapshot → pi-minimal footer rows (tiny, read-only)
authoring   CC Workflow shim · /workflows browser · @mentions                  — later, in the fork
```

**Host/provider rule.** The fork *provides* capabilities (agents, models, teams, workflows, run state) and *contributes* them into pi-minimal surfaces through pi-minimal's public contribution APIs whenever pi-minimal is loaded. Where pi-minimal has no slot yet (e.g. a management panel), the fork renders its own TUI (`/roster`, `/subagents-fleet`) and the slot is proposed to pi-minimal as a host feature. The fork never imports pi-minimal, and pi-minimal never imports the fork; both sides talk over `pi.events` contracts, as `pi-agent-activity` already does. The roster lives in the fork, not in pi-minimal, because it needs the catalogue resolver, model resolution and `registerWorkflowResource` in-process.

### Fork foundations (`raviy06/pi-subagents`, one PR, additive)

F1. **Catalogue over RPC.** New `manage` actions `agents.list`, `agents.get`, `models.list` exposed through `SUBAGENT_RPC_MANAGEMENT_ACTIONS`, routed to the existing `handleList` / `handleGet` / `handleModels` in `src/agents/agent-management.ts`. The RPC reply `data` carries structured entries: `{ name, source: builtin|package|user|project|runtime, filePath?, packageName?, description, model?, effectiveModel?, thinking?, disabled, overridden: string[], restricted?: boolean, launcher?, runner? }`. Advertised in `ping.capabilities.agentsCatalog = { version: 1 }`.

F2. **Activity change event.** The fork emits `subagents:activity:changed` `{ version: 1, revision, generatedAt }`, coalesced to ≤1 per 250 ms, whenever any of the existing `subagent:child-status`, `subagent:async-started`, `subagent:async-complete`, `subagent:foreground-complete`, `subagent:process-terminal` fire. Consumers then call `status` once instead of polling. Advertised as `ping.capabilities.activityEvents = { version: 1, event: "subagents:activity:changed" }`. Wired at `session_start`, torn down at `session_shutdown` (never at factory time).

F3. **Durable run records.** On every top-level run reaching a terminal state the fork calls `pi.appendEntry("subagents:record", { version: 1, runId, agent, handle?, task (≤200 chars), state, startedAt, endedAt, durationMs?, model: { requested?, effective?, fallbackReason? }, usage?: { input, output }, workflowRunId?, missionId? })`. Append-only history; consumers rebuild on reload.

F4. **Richer `ActivityEntry` (v1 → v1.1, additive).** Add `task?: string` (≤120 chars), `handle?: string`, `model?: { requested?: string; effective?: string; fallbackReason?: string }`, `startedAt?: number`. `ACTIVITY_STATUS_VERSION` stays `1`; `ping.capabilities.activityStatus` gains `fields: ["task","handle","model","startedAt"]` so a consumer can feature-detect.

F5. **Model fallbacks (resolution-time).** `agentOverrides.<name>.fallbacks?: string[]`, agent frontmatter `fallbacks:`, and per-launch `fallbacks` are accepted (the removed `fallbackModels` key keeps erroring with a pointer to `fallbacks`). At launch, `resolveModelSelection` is given the ordered candidate list `[model, ...fallbacks]`; the first candidate that is registered in the host registry **and** passes `modelScope` wins. Skipping is recorded as `fallbackReason: "unregistered" | "out-of-scope" | "provider-unavailable"`. No provider request is ever retried on a different model; a launch with no viable candidate fails as today. The effective model and reason are written to `status.json`, the fleet DTO, `ActivityEntry.model` and the run record. Documented in `docs/models.md` as a fork deviation with the upstream rationale quoted.

F6. **Handles.** *Proposed upstream first* (nicobailon #TBD). Fork implements only after the upstream discussion, or if the roster's `@mention` work becomes blocked. Shape: optional `name` on spawn/`runs.run`, slugged, ≤64 chars, `main` reserved, collision → `-2` suffix; shown in FleetView and `ActivityEntry.handle`. Not part of the foundations PR.

### Roster module (fork `src/roster/`)

Data, in pi settings (user `~/.pi/agent/settings.json`, project `.pi/settings.json`; project narrows user):

```jsonc
"agentRoster": {
  "assignments": {
    "scout":      { "model": "devaigateway/gpt-6-sol:high", "fallbacks": ["anthropic/claude-sonnet-5:medium"] },
    "researcher": { "model": "anthropic/claude-opus-5-5:high", "fallbacks": ["devaigateway/gpt-6-astra:high"] }
  },
  "teams": {
    "spec-council": {
      "shape": "council",
      "chair":   { "agent": "oracle", "model": "devaigateway/gpt-6-astra:high" },
      "members": [ { "agent": "karl-popper" }, { "agent": "amos-tversky", "model": "anthropic/claude-opus-5-5:high" }, { "agent": "john-woods" } ],
      "passes": 2, "context": "fresh"
    },
    "review-pair": { "shape": "parallel", "members": [ { "agent": "reviewer" }, { "agent": "evidence-auditor" } ] }
  }
}
```

- **Assignments** *are* `subagents.agentOverrides.<name>.{model,fallbacks,thinking}` (or agent frontmatter). There is no separate `agentRoster.assignments` key: one canonical place, nothing to project or keep in sync. Editing goes through the existing `/subagents <agent>` admin (scope-aware, confirmed), which gains a *Change fallbacks* action. *(Amended during implementation; the JSON example above predates this and its `assignments` block should be read as `subagents.agentOverrides`.)*
- **Teams** compile to workflow scripts from a **shape** and are registered at `session_start` through the fork's internal workflow-resource registry (same contract as `registerWorkflowResource`) (name `team.<name>`, version = hash of the team definition). Built-in shapes: `parallel` (`runs.all`), `council` (members in parallel → chair synthesis → up to `passes` bounded cross-exam rounds via `resume`), `pipeline` (member N's output feeds N+1). A user shape is a `.js` file in `~/.pi/agent/workflows/shapes/<shape>.js` or `.pi/workflows/shapes/<shape>.js` exporting `compile(team, args) → script`.
- **UI** `/roster` v1 is text-first: overview (agents by source with model chain, thinking, provenance flags; teams with launch form; warnings and settings diagnostics), `agent <name>` → admin, `team <name>`, `team add|remove` with a confirmed JSON preview, `run <team> <task>`, `reload`. A tabbed TUI (Models tab with `enabledModels` ∩ `modelScope`, Runs tab with steer/stop) is a follow-up once the data surfaces are proven.
- **pi-minimal.** The `activity` footer slot is owned by `pi-agent-activity`; the roster publishes nothing there (one owner per slot), so no duplicate rows appear. A management panel slot is a pi-minimal host feature to propose later.
- Settings resolution follows pi's project-over-user precedence (same pattern as gauntlet's `gauntlet_setting`).

### Compatibility and policy

- All fork changes are additive and feature-detectable through `ping.capabilities`; `pi-agent-activity` 0.2.0 keeps working unchanged and gains fields when upgraded.
- `docs/fork-maintenance.md` gains a pointer to this spec; the fork's bounded-delta statement is amended to: additive runtime fields/events/RPC actions under `src/runs/shared/activity-*`, the self-contained `src/roster/**` module and its single wiring block in `src/extension/index.ts`, plus the declared `fallbacks` deviation. Upstream never touches `src/roster/`, so sync conflicts stay confined to wiring lines and docs.
- F2, F3, F4 and F6 are candidates to propose upstream; F5 is a declared fork deviation.

## Acceptance criteria

- AC1 `ping` advertises `agentsCatalog`, `activityEvents`, and `activityStatus.fields`; an RPC `manage` with `action: "agents.list"` returns structured entries including `source` and `overridden` for a user-overridden builtin.
- AC2 Launching one child produces at least one `subagents:activity:changed` event with a monotonically increasing `revision`, and never more than one per 250 ms window under a burst of 10 status events.
- AC3 A finished top-level run leaves exactly one `subagents:record` session entry carrying `runId`, `agent`, `state`, `startedAt`, `endedAt` and `model.effective`.
- AC4 `activityStatus` entries for a running child include `task`, `startedAt` and `model.effective`; the snapshot still validates against the v1 bounds (≤64 entries, ≤32 KiB).
- AC5 With `agentOverrides.x = { model: "nope/none", fallbacks: ["<registered>"] }`, launching `x` runs on the registered model and reports `model.requested = "nope/none"`, `model.effective = "<registered>"`, `fallbackReason = "unregistered"`; with no viable candidate the launch fails with today's error; a provider error never changes model.
- AC6 The legacy key `fallbackModels` still errors, and the message names `fallbacks`.
- AC7 `npm run typecheck`, `npm run test:all` (from a path outside `$HOME`), `npm run build:pkg`, `npm run check:release -- --packed` pass; `pi-agent-activity`'s `scripts/smoke.py` passes against the new `dist-pkg`.
- AC8 (roster, phase 2) Registering a team produces a `team.<name>` workflow resource whose `resolve({task})` yields a script that validates with the fork's workflow validator; `/roster` can write an assignment as a confirmed settings diff; with pi-minimal loaded, roster run rows appear through the footer contribution API and no duplicate widget is shown.

## Open questions

- Upstream appetite for F6 (handles) and F2–F4; open the discussion with the foundations PR link.
- Whether the roster should also project `thinking` or leave it to agent frontmatter only (default: project it; it is part of a "model policy").
