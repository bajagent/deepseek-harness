---
description: "The Claude lead profile bundle for users who want their own Claude Code session to lead a team of Claude Code agents through MCP, with no Harness model."
kind: "package-bundle"
---

# @deepseek-ai/dsh-claude-lead-app

English

## Summary

Select this bundle in a profile when your own Claude Code session should be the root agent of a team. Claude Code launches `dsh --profile claude-lead` as an MCP stdio server; the server registers a root Agent named `lead` that stands in for that session and never calls a Harness model. Through MCP tools the session spawns agents, messages them, lists them, reads or waits for what they send back, plans work on the shared task board, and gets a link to the live team view. Children run on Claude Code by default through [`dsh-subagent-claude-code-team`](../../subagent/subagent-claude-code-team/README.md), so the whole team uses Claude Code's native authentication.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Create a profile whose bundles are, in order, `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-subagent-claude-code-team`, and `@deepseek-ai/dsh-claude-lead-app`, then register it with Claude Code:

```sh
claude mcp add --scope user dsh-team -- dsh --profile claude-lead
```

The server's working directory is the project Claude Code runs in, and every spawned agent starts there. Configure specialties and the Claude permission mode on the `subagent-claude-code-team` row of the profile's `cordis.patch.yml`; this bundle sets that row's `defaultBackend` to `claude`.

| Field | Default | Meaning |
|---|---|---|
| `waitDefaultSeconds` | `600` | How long `wait_for_messages` waits when the call gives no timeout |
| `waitMaxSeconds` | `3600` | Longest wait one call may request |
| `taskBoard` | `true` | Turn on the shared task board for each new lead |

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Command line, lead Session and Agent registration, and the stdio transport lifecycle |
| [`src/lead-agent.ts`](src/lead-agent.ts) | The model-less root Agent and its waitable inbox |
| [`src/server.ts`](src/server.ts) | MCP tools: `spawn_agent`, `send_message`, `list_agents`, `check_inbox`, `wait_for_messages`, `team_task_*`, `team_view` |

The lead Agent owns a real root Session, so the subagent runtime catalogs its children and delivers completion notices and agent messages to it like any root. Its inbox never wakes a model: the MCP tools drain it. On disconnect the server drains every descendant before closing.

<a id="model-experience"></a>
## Model Experience

### Lead MCP tools

#### What the model sees

The Claude Code session sees the server instructions and eleven tools: the five team tools above, five `team_task_*` board tools, and `team_view`. `spawn_agent` takes `task`, `description`, and optional `name`, `backend`, `provider`, and `model`, plus a `specialty` enum when specialties are configured. `send_message` takes `agent` and `message`. `wait_for_messages` takes an optional `timeout_seconds`. Drained messages are joined with `---` separators.

##### Verbatim text for the server instructions

```markdown
You lead a team of agents. You are "lead". Use spawn_agent to start agents on self-contained tasks; they do not see your conversation. Their final answers and their messages to you arrive in your inbox: call wait_for_messages to block until something arrives, or check_inbox to read without waiting. Use send_message to message any agent by name, and list_agents to see names and status. When the shared task board is on, use the team_task_* tools to plan work as tasks that agents claim and complete. Call team_view to get a link to a live picture of the team for the user. Claude agents keep their conversation: send_message to a finished Claude agent resumes it, even when its completion notice says it cannot receive follow-up messages.
```

#### Token effect

Fixed tool schemas and instructions in the Claude Code session, growing with the specialty catalog; each drained message adds its text.

#### KV Cache effect

Prefix-stable in the Claude Code session while the configuration is unchanged.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **One team per server process** — each Claude Code session that starts the server gets its own lead and team; teams do not survive the session.
- **`dsh` children need a Harness model** — the profile has no model by default, so `backend: dsh` fails until one is configured.

<a id="dev-note"></a>
## Dev Note

None.
