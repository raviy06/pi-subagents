# Agent roster (fork addition)

The roster is where you decide how agents, models and teams combine. It adds nothing the
model can do on its own: it reads and writes the same settings you could edit by hand, and
every write is shown and confirmed first. pi-minimal (or any host) stays in charge of the
screen; the fork only provides the data and the commands.

## What you get

| Need | Where |
|---|---|
| See every agent, where it came from, and what it runs on | `/roster` |
| Assign a model, ordered fallbacks and thinking to an agent | `/roster agent <name>` (same as `/subagents <name>`) |
| Group agents into a reusable team with a shape | `/roster team add …` or `agentRoster.teams` in settings |
| Launch a team | `/roster run <team> <task>` or `subagent({ workflow: "team.<name>", args: { task } })` |
| Inspect what a team will do | `/roster team <name>` shows the compiled workflow |

## Models: primary and fallbacks

A model assignment is the existing `subagents.agentOverrides.<name>` entry (or the agent's
frontmatter). The roster adds **ordered fallbacks**:

```json
{
  "subagents": {
    "agentOverrides": {
      "researcher": { "model": "anthropic/claude-opus-5-5:high", "fallbacks": ["devaigateway/gpt-6-astra:high", "anthropic/claude-sonnet-5:medium"] }
    }
  }
}
```

`/roster agent researcher` opens the admin with *Change model*, *Change fallbacks* and *Change
thinking level*. Fallbacks apply at **resolution time** only: the first candidate that is
registered in the host and allowed by `modelScope` is launched, and the run reports
`requestedModel`, `model` and `fallbackReason`. A running child never switches model. See
[models](models.md#fallbacks-fork-addition).

## Teams

Teams live under the top-level `agentRoster.teams` key, in user settings
(`~/.pi/agent/settings.json`) or project settings (`.pi/settings.json`; project wins by name):

```json
{
  "agentRoster": {
    "teams": {
      "review-pair": { "shape": "parallel", "members": ["reviewer", { "agent": "evidence-auditor", "model": "anthropic/claude-opus-5-5:high" }] },
      "spec-council": {
        "shape": "council",
        "description": "Independent critique of a spec",
        "chair": { "agent": "oracle", "model": "devaigateway/gpt-6-astra:high" },
        "members": ["karl-popper", "amos-tversky", "john-woods"],
        "passes": 2
      },
      "ship": { "shape": "pipeline", "members": ["worker", "reviewer"] }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `shape` | `parallel` (all members at once, outputs returned side by side), `pipeline` (each member receives the previous member's output), `council` (members answer independently, the chair synthesises, then up to `passes` rounds of cross-examination by resuming each member; a member that cannot be resumed is re-run fresh with its earlier position) |
| `members` | 1–8 agent names, or `{ "agent", "model"? }` objects for a per-member model |
| `chair` | council only; `{ "agent", "model"? }` |
| `passes` | council only; 1–3 chair rounds (default 2) |
| `description` | optional text shown in `/roster` |

At `session_start` every team is registered as a named workflow resource `team.<name>`, so the
model (or you) launches it like any other named workflow:

```js
subagent({ workflow: "team.spec-council", args: { task: "Critique docs/specs/2026-10-25-agent-roster.md" }, async: true })
```

The compiled script has only literal child keys, agents and models, so the normal workflow
validator checks the whole team before any child starts. Teams never grant host-command
authority. `/roster team <name>` prints the exact script that will run; `/roster team add` and
`remove` write settings after a confirmation that shows the JSON; `/roster reload` re-reads
settings and re-registers.

```
/roster team add review-pair parallel reviewer,evidence-auditor=anthropic/claude-opus-5-5:high
/roster team add spec-council council karl-popper,amos-tversky --chair oracle=devaigateway/gpt-6-astra:high --passes 2 --description Spec critique
/roster team remove ship --project
/roster run review-pair Review the diff on this branch for correctness and test gaps
```

A team result is plain JSON: `parallel` returns `{ team, shape, members, results[{ member, runId, output }] }`,
`pipeline` returns `{ team, shape, stages[], output }`, `council` returns
`{ team, shape, chair, members, passes, rounds[], memo, memoRunId, memberRunIds }`.

## Principles

1. Extensions provide and manage; they never decide. Nothing here auto-delegates, auto-selects a
   team, or rewrites agent files silently.
2. Everything is data in pi settings or files in your directories. `/roster` is a convenience over
   `settings.json`, never the only path.
3. Project settings can narrow (disable, scope); you can always see the provenance and eject.
4. Hosts own surfaces. With pi-minimal loaded, run activity reaches its footer through the
   `pi-agent-activity` companion; the roster does not publish a second activity row set.

## Relationship to other pieces

- `pi-agent-activity` reads the fork's `activityStatus`, `subagents:activity:changed` and run
  records to render footer rows; teams show up there as ordinary workflow children.
- `pi-gauntlet` is a separate, opinionated process layer. Once teams exist it can point its
  council at a roster team, but nothing in the roster depends on gauntlet.
- The spec and plan behind this module: [`specs/2026-10-25-agent-roster.md`](specs/2026-10-25-agent-roster.md),
  [`plans/2026-10-25-agent-roster.md`](plans/2026-10-25-agent-roster.md).
