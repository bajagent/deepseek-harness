---
description: "Resumable Claude Code team members for users and maintainers who want Claude Code agents to spawn, message, and be messaged by other agents in a subagent tree."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code-team

English

## Summary

Install this Profile Bundle when Claude Code should take part in a multi-agent team instead of running one isolated task. Any agent can start a child with `spawn_agent`, choosing a configured specialty, a backend (`dsh` for a Harness agent, `claude` for Claude Code), and a model. Claude members keep their Claude session between runs: a message to an idle member resumes its conversation, and a message to a working member reaches it through its inbox. Claude members get the same powers through in-process team tools, so they can spawn Harness or Claude agents and message any agent, including `lead`. Native Claude settings and authentication stay authoritative, as in [`dsh-subagent-claude-code`](../subagent-claude-code/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the bundle to a profile and override its row from the profile's `cordis.patch.yml`:

```yaml
- id: subagent-claude-code-team
  name: '@deepseek-ai/dsh-subagent-claude-code-team'
  config:
    permissionMode: acceptEdits
    maxDepth: 3
    specialties:
      researcher:
        description: Finds and summarizes facts with sources.
        instructions: You research questions thoroughly and cite every source.
      reviewer:
        description: Reviews code changes with Claude.
        instructions: You review diffs for correctness bugs and report each with evidence.
        backend: claude
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-team` | Provider name on `ctx.subagents` for Claude members |
| `dshProvider` | `spawn` | Provider that runs `dsh` children; it must support `agentOptions` and `depthLimit` |
| `defaultBackend` | `dsh` | Backend when neither the call nor its specialty chooses one |
| `model` | native Claude settings | Claude model for members without a model choice |
| `permissionMode` | `dontAsk` | Non-interactive Claude Code permission mode; team tools are always allowed |
| `env` | `{}` | Entries layered over the credential-scrubbed parent environment |
| `toolTimeoutMs` | `3600000` | Upper bound for one Claude-side team-tool call, passed as `MCP_TOOL_TIMEOUT` |
| `disposeGraceMs` | `3000` | Grace between Claude Code termination tiers |
| `maxDepth` | Host `subagent.maxDepth` | Delegation-depth cap for `dsh` children |
| `maxClaudeDepth` | `2` | How deep Claude members may nest under one another |
| `specialties` | `{}` | Named `description`, `instructions`, and optional `backend`, `provider`, and `model` |
| `viewPort` | `3095` | First localhost port the live team view tries, moving up when taken; `0` turns the view off |
| `feedLimit` | `200` | Events the view keeps per team |

A `dsh` specialty that names a route sets `provider` and `model` together. A `claude` specialty may set only `model`. Invalid combinations fail at load.

### Watch the team

The plugin serves a live team view on `127.0.0.1`, starting at `viewPort`. Ask any agent for the link (`team_view`), or read the `claude-team view:` line in the log. The page draws each agent as a character in a house: green plumbob at a desk while working, blue at the meeting table while coordinating, yellow at the water cooler while waiting, grey on the couch while idle, and red when a run stopped. Envelopes fly between agents as they message each other, and the page also shows each agent's current activity, the shared task board, and an event feed. The address carries a random token; requests without it are refused.

### Shared task board

When agent teamwork (Team mode) is on, Claude members get `team_task_list`, `team_task_create`, `team_task_claim`, `team_task_complete`, and `team_task_release`. The board's service records a task's owner as an Agent, and Claude members act through their host Agent, so the board itself shows the host as owner. This package remembers which member claimed each task: the Claude tools, the view, and other members see the member's name, and only the claiming member can complete or release its task.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema, validation, and registration of the provider and tools |
| [`src/team.ts`](src/team.ts) | Member registry per subagent tree, spawn, message routing, and the resumable provider |
| [`src/run.ts`](src/run.ts) | One streaming-input Agent SDK query that takes a turn per inbox batch |
| [`src/mcp.ts`](src/mcp.ts) | Claude-side `spawn_agent`, `send_message`, `list_agents`, and `check_inbox` |
| [`src/tools.ts`](src/tools.ts) | Harness-side `spawn_agent` and `message_claude_agent` |
| [`src/process.ts`](src/process.ts) | Places the SDK-spawned CLI under the shared subprocess owner |
| [`src/activity.ts`](src/activity.ts) | Per-agent activity and per-team event feed |
| [`src/view.ts`](src/view.ts) | Snapshots, Harness tool observation, and the token-protected view server |
| [`src/view-page.ts`](src/view-page.ts) | The self-contained view page |

**Members and runs.** A Claude member is a named entry in its tree's registry with a persisted Claude session id. Each run is one external activation on the subagent runtime: the first is parent-delivered and cataloged under the member's name, and later runs are caller-delivered resumes whose answer this package forwards. A run keeps its Claude Code process while messages arrive: at every turn end, queued inbox messages become the next user turn, and the run ends when the inbox is empty. Messages that arrive while a run is finishing wake the member again.

**Routing.** A message to a working member waits in its inbox, where `check_inbox` or the next turn end delivers it. A message to an idle member resumes its session; the member's answer goes to the sender. A finished child's answer goes to the agent that started it, and a woken member's unsolicited answer goes to whoever started that member, so answers move up the tree and never loop back to the child. A Claude member reaches Harness agents by steering a live Agent in its tree, or through `ctx.subagents.sendMessage` for a cold one.

**Children of Claude members.** The Harness Agent that started a member owns every child the member spawns, so those children appear beside the member in the subagent tree and count against that Agent's depth.

<a id="model-experience"></a>
## Model Experience

### Harness tool schemas

#### What the model sees

`spawn_agent` takes `task`, `description`, and optional `name`, `backend`, `provider`, and `model`, plus a `specialty` enum when specialties are configured; its description lists each specialty's id, fixed backend, and description. `message_claude_agent` takes `agent` and `message`. `team_view` takes no arguments and returns the view's address. Results render as `started <backend> agent <name>` and `message delivered to Claude agent <agent>`. Answers arrive later as `Agent "<name>" finished:` messages.

#### Token effect

Two fixed schemas per request while the plugin is loaded, growing with the specialty catalog.

#### KV Cache effect

Prefix-stable while the configuration is unchanged; editing specialties changes the schema text.

### Claude member system prompt and team tools

#### What the model sees

Each Claude member's Claude Code system prompt is appended with its name, its host's name, the team tools including the task board, the specialty catalog, and its own specialty instructions. Inbox messages arrive framed as `Agent "<sender>" sent a message (reply with send_message to "<sender>" if a reply is needed):`.

#### Token effect

A fixed append per member session plus nine MCP tool schemas; inbox messages and board listings add their text.

#### KV Cache effect

Independent of the parent request cache; a resumed member reuses its own Claude session.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The member registry lives in memory** — after a restart, previously spawned Claude members cannot be messaged, although their Claude sessions remain on disk.
- **Only the first run is cataloged** — resumed runs are caller-delivered and do not appear as separate subagent rows.
- **The board shows a Claude member's host as owner** — Team's service records Agent owners, so dsh's own task tools and Task board panel show the host; only this package's tools and view show the member.
- **The view is per process** — each dsh process serves its own view on the next free port and forgets its feed on exit.
- **Built-in `send_message` cannot reach Claude members** — Harness agents use `message_claude_agent`; the subagent runtime only delivers to local continuable children.
- **One reply per wake** — when several queued messages wake an idle member together, only the first sender receives the answer automatically; the member is told to reply to the others with `send_message`.

<a id="dev-note"></a>
## Dev Note

None.
