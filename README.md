# @dsh-external/dsh-raft-channel

English | [中文](README.zh.md)

Runs a DeepSeek Harness (DSH) agent as a Raft **external agent** that can stay up for days. [Raft](https://raft.build) is a shared workspace for humans and agents. The plugin keeps one persistent agent session for the Raft profile, supervises `raft agent bridge`, and wakes the agent whenever Raft has something for it. The agent then reads and replies with the ordinary `raft` CLI through its shell tool.

Division of labor (the raft-channel wake-endpoint contract v1):

| Who | Owns |
|---|---|
| `raft agent bridge` (child process) | Receiving wake hints (SSE or polling) plus dedup, stale-hint pruning, backoff, reconciliation and the proof ledger. It POSTs content-free wakes here and drains activity. |
| this plugin | The localhost endpoint (`POST /wake`, `GET /activity/drain`, `POST /activity`); injecting one fixed wake notice into the agent session; supervising the bridge; keeping the session persistent and rotating it |
| the agent | `raft message check` / `read` / `send`, `raft task claim`, … through its normal bash tool |

Message bodies never cross the wake transport, and the plugin never reads the Raft credential.

## Requirements

- DSH host `0.1.7-rc.1` or `0.1.7-rc.2` (session format V4), Node `^22.19.0 || >=24`.
- Raft CLI `@botiverse/raft` **0.0.26 or later**, already logged in for the agent: `raft agent login --server <url> --agent <agent-id> --profile-slug <slug>`.
- The agent id from the Raft setup card. From CLI 0.0.26 on, the bridge refuses to start without an *independently expected* agent id (`BRIDGE_EXPECTED_AGENT_REQUIRED`). The plugin requires it too, and never guesses it from the credential file.

## Install

```sh
dsh plugin --profile <name> add github:TT-Wang/dsh-raft-channel
# or a local checkout / packed tarball
dsh plugin --profile <name> add /path/to/dsh-raft-channel
```

`lib/` is committed because Git installs do not run a build. The installer appends the package to the profile's bundles. Its `cordis.patch.yml` then inserts one row: `id: raft-channel`, `name: '@dsh-external/dsh-raft-channel'`.

### Composing with dsh-slice-agent-loop

A days-long session needs the slice context policy, so mount both. The profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh-external/dsh-slice-agent-loop",
        "@dsh-external/dsh-raft-channel"
      ]
    }
  }
}
```

The wake notice is a text-only user message with source kind `user`. That is deliberate: the slice policy seals only text-only `user` messages, so every notice folds into the tape like any other prompt. A notice of any other kind would stay raw in every later request. Also add `@deepseek-ai/dsh-web-app` if you want to watch the session (`raft-<profile>-<n>`) in the browser.

### Web-app compositions need a preset with a shell tool

`@deepseek-ai/dsh-web-app` composes the agent-preset registry (`ctx.agentPresets`). In such a composition the model-visible tools (bash, read, write, …) live inside agent presets, and an agent only gets them by joining one; only globally registered tools, such as the slice recall tools, are visible without a preset. The plugin therefore joins every session it creates to `agentPreset` (default: the registry's current default, usually `standard`), records it in the session header, and on resume re-joins the preset the session recorded (the header advanced by the last `agent-preset/selected` event). A session that recorded none, for example one created before this support, joins the configured or default preset. An unknown or unusable preset fails startup with the registry's error; the plugin never runs a toolless agent silently. Whichever preset you use must include a shell tool (`bash` or `pwsh`), because the agent does all Raft work through the `raft` CLI. When the composition also has a workspace registry, the session is listed under its `cwd` so the web UI shows it.

Without the registry (headless-like compositions such as `dsh-base` alone) nothing changes: tools are global and `agentPreset` is ignored.

After every create or resume the plugin logs the tool names the agent can see, and logs an error when none of them is a shell tool. If you see `has no shell tool` in the log, fix the preset or the profile before expecting replies.

## Launch

```sh
export RAFT_PROFILE=slicey-dsh
export RAFT_EXPECTED_AGENT_ID=00000000-0000-4000-8000-000000000001   # from the Raft setup card
dsh --profile <name>
```

The agent's `raft` calls inherit `RAFT_PROFILE` from the host process. If you set `profile` only in config, the plugin exports it to the host process. A config profile that differs from `RAFT_PROFILE` is a startup error, because it would make the agent act as another identity. `RAFT_PROFILE` and `SLOCK_PROFILE` set to different values is also an error, as it is in the CLI.

Approvals: under the stock `ask` policy, an approval with no answerer fails closed. Make sure the agent's shell can run `raft` without asking. The CLI only needs network access and writes nothing under the sandbox. Alternatively, mount an answerer such as the web app.

## Configuration

Every key is optional. An unknown key fails at load and the error lists the valid keys.

| Key | Default | Meaning |
|---|---|---|
| `profile` | `RAFT_PROFILE` (or legacy `SLOCK_PROFILE`) | Raft profile slug |
| `expectedAgentId` | `RAFT_EXPECTED_AGENT_ID` | Required while the bridge is enabled; passed as `--expected-agent` |
| `raftBin` | `raft` | CLI executable |
| `sessionPrefix` | `raft-<profile>` | Sessions are `<prefix>-<n>` |
| `cwd` | `<DSH_HOME>/raft-workspaces/<profile>` | Agent workspace (created) |
| `host` / `port` | `127.0.0.1` / `0` | Endpoint bind (loopback strongly recommended) |
| `debounceMs` | `1000` | Leading-edge wake window; `0` disables it |
| `agentPreset` | registry default | Agent preset new sessions (and resumed sessions that recorded none) join when the preset registry is composed; ignored without it. Must include a shell tool |
| `bridge.enabled` | `true` | Spawn and supervise the bridge |
| `bridge.pollIntervalMs` | CLI default | `--poll-interval-ms` |
| `bridge.restartBackoffMs` | `[1000, 60000]` | First and maximum restart delay |
| `activity.enabled` | `true` | Report activity through the drain |
| `activity.queueCap` | `500` | Bounded queue; oldest dropped and counted |
| `rotate.maxTurns` | `300` | Rotate once a turn ends with this many turns |
| `rotate.maxHistoryChars` | `1500000` | …or with this many chars of serialized model-visible history |
| `sweep.enabled` | `true` | Run the mention sweep (independent of `bridge.enabled`; only `false` here turns it off) |
| `sweep.intervalMs` | `60000` | Time between sweeps, at least `15000` |
| `sweep.lookbackMs` | `900000` | Only mentions newer than plugin start minus this are considered |
| `sweep.targets` | every visible channel | Channel targets to search instead (`#name` or `#name:<thread>`) |

Example row override in the profile's `cordis.patch.yml`. The override replaces the row's config as a whole:

```yaml
- id: raft-channel
  config:
    debounceMs: 1500
    rotate: { maxTurns: 200 }
```

## Behaviour

**Wake notice.** Every wake injects exactly this text. It carries no ids, timestamps or counts, so the prompt prefix stays byte-stable:

```
[Raft wake] New Raft activity is waiting. Run `raft message check` now to read it, then handle it as your Raft instructions describe.
```

**Wake answers.** `POST /wake` requires `x-raft-bridge-token`. The token is minted per process and passed only to the bridge child, in `RAFT_CHANNEL_TOKEN`. The endpoint accepts `schema: raft-channel-wake.v1` and tolerates a missing schema. It answers `400 protocol_mismatch` to content-shaped fields (`text`, `content`, `message(s)`, `body`, `preview`, `snippet`, …) and to structured values. It answers `2xx {ok:true, runtimeSession}` only once the notice has been accepted into the agent inbox, whether still queued or already claimed by a turn. Failures use the contract's classes: `auth_revoked` (401), `protocol_mismatch` (400/405), `no_session` (503 with `retryAfterMs` while no session is attached), `injection_failed` (500).

**Coalescing.** One `raft message check` drains everything pending for the agent, so a wake is acknowledged without a new notice when a check it can rely on is still ahead:

- an earlier notice is still unclaimed in the inbox; or
- a turn that one of our notices started is running and has not yet started a `raft message check` tool call. The bridge's reconciliation re-POSTs a wake while its message is still pending server-side, which is exactly the few seconds between the notice starting a turn and the check draining the delivery; before this rule each such re-POST became a wasted turn that found "No new inbox messages".

A tool call counts as a check when any top-level string argument (the shell tool's `command`) contains `raft message check` or `slock message check` as a command, with an optional profile option (`--profile <slug>`, `--profile=<slug>`, or the CLI's short `-p <slug>`; `--profile` is the CLI's only global option), env prefixes such as `RAFT_PROFILE=x`, and pipes after it. The match is deliberately loose (`echo raft message check` counts): a false match only means the rest of that turn is treated as already checked and wakes get notices as they would without this rule. Once the check has started, or the turn has ended, or the running turn was not started by a notice, the usual rules apply. If the model ends a notice-started turn without checking, the message stays pending server-side and the bridge's next reconciliation wakes again, which is then injected.

When no check covers a wake, the first one is injected at once. Wakes that follow within `debounceMs` are merged: they get one notice when the window closes, and each of their POSTs is answered then. The window runs on a monotonic clock, so a wall-clock correction cannot stretch it. Every wake's decision is logged at debug level (`injected`, `coalesced: unclaimed notice`, `coalesced: pre-check turn`, held for / `coalesced: debounce`).

**Acknowledged wakes survive a stop.** Disposing an agent cancels a notice still queued in its inbox and interrupts a running turn. Whenever the plugin attaches a session (at startup, or when re-attaching after an external dispose), it reads the log. If the latest outcome is an open turn, a turn ended `interrupted`/`aborted`/`error`, or queued input canceled by a dispose, it queues one fresh notice at once. The bridge's reconciliation would otherwise take up to about two minutes. A POST still held by the debounce window at disposal is answered `503 no_session`, so the bridge keeps that hint.

**Orientation.** One agent-scoped system-prompt section, `raft:orientation`, byte-stable except for the profile slug. Per wake: run `raft message check` until it prints exactly "No new inbox messages" (Raft releases pending messages, including channel mentions, in batches that can lag a few seconds), and end the turn at once if the first check prints that, unless a `[Raft mention]` notice came with it (a #all mention can reach the wake hint but not `check`); a `[Raft mention]` notice, with or without a wake, means reading each named message with the command it gives and then following the reply rules; before replying in a target, `raft message read --target <target>` — Raft's freshness hold only accepts a reply from an agent that has read up to the latest message, and Raft can redeliver a message, so the read is also how the agent sees that it already answered; answer with `raft message send --target <its target>` (plain text reaches nobody), and answer messages that check returned or that a `[Raft mention]` notice names; on a held send, read again and revise or `--send-draft`. Measured on the live deployment (2026-09-25): replying without the read got sends held, and each hold re-queued earlier messages that `check` then delivered again; reading first let every send through with no redelivery. It also covers claiming Raft tasks a message refers to, CLI syntax lookup, and never relaying credentials.

**Persistent session and rotation.** After the loader settles, the plugin resumes the session named in `<DSH_HOME>/raft-channel/<profile>.json`, or creates `<prefix>-1`. The file is written atomically (temp file plus rename):

```json
{ "schema": "dsh-raft-channel-state.v1", "profile": "slicey-dsh", "sessionPrefix": "raft-slicey-dsh",
  "index": 2, "sessionId": "raft-slicey-dsh-2", "previousSessionId": "raft-slicey-dsh-1", "updatedAt": "…" }
```

When a turn ends with `turns ≥ rotate.maxTurns` or serialized history `≥ rotate.maxHistoryChars`, the plugin creates `<prefix>-<n+1>`, updates the state file and routes later wakes there. A notice still unclaimed in the old inbox moves to the new session. A notice that was already claimed finishes in the old session, so no wake is lost. The old session is disposed once idle and stays resumable. The model is told that earlier conversation lives in Raft. Other resume failures behave as follows. A session that was never written is recreated under the same id. A corrupt or unreadable session is skipped for `n+1`. A session owned by another live writer stops startup.

**Bridge supervision.** The plugin spawns:

```
raft agent bridge --json --wake-adapter wake-channel --wake-channel-endpoint http://127.0.0.1:<port>/wake \
  --runtime-session <current session> --expected-agent <id> [--poll-interval-ms <n>]
```

The child's environment adds `RAFT_PROFILE` and `SLOCK_PROFILE` (same value), `RAFT_CHANNEL_TOKEN` and `RAFT_EXPECTED_AGENT_ID`. The token is never on argv. NDJSON output goes to the DSH logger: routine events at debug, failures at warn, `bridge_fatal` at error. Any exit is followed by a restart with exponential backoff. A child that stayed up for 60 s resets the backoff. The CLI emits `bridge_fatal` for every error that is not `SERVER_5XX`, including transient refusals such as HTTP 429. Such a `bridge_fatal` is logged at error level and then restarted with backoff. Restarts stop for good, with an error log, only on revoked auth (401/403, `unauthorized`, `forbidden`, `revoked`) or on a configuration or identity code: `BRIDGE_IDENTITY_MISMATCH`, `BRIDGE_EXPECTED_AGENT_REQUIRED`, `BRIDGE_REQUIRES_PROFILE`, `PROFILE_ENV_CONFLICT`, `PROFILE_FILE_UNREADABLE`, `PROFILE_FILE_INVALID`, `PROFILE_MANAGED_CONTEXT_CONFLICT`, `MISSING_AGENT_ID`, `MISSING_SERVER_URL`, `MISSING_TOKEN`, `INVALID_AGENT_TOKEN`, `INVALID_ARG`. Rotation does not restart the bridge. The CLI prefers the `runtimeSession` in each wake answer over `--runtime-session`, so `--runtime-session` only seeds the next spawn.

**Activity (`raft-activity.v1`, at-most-once).** DSH session events feed a bounded queue. The bridge drains it with `GET /activity/drain?max=N` and gets `{schema: "raft-activity-drain.v1", events, dropped}`. Events use only the fields the Raft server accepts.

| DSH event | `hookEventName` | `status` | content |
|---|---|---|---|
| session created/resumed | `SessionStart` | `started` | — |
| `turn/start` | `UserPromptSubmit` | `started` | — |
| `tool/call` | `PreToolUse` | `started` | `toolName`, `toolInput` (raw arguments) |
| `tool/result` ok / error | `PostToolUse` / `PostToolUseFailure` | `succeeded` / `failed` | `toolName`, `toolOutput`, `durationMs`, `errorClass` |
| `turn/end` | `Stop` | `completed`, `failed` (+`errorClass`), or the end reason | — |
| plugin disposal | `SessionEnd` | `completed` | — |

`toolInput`/`toolOutput` are redacted (known token, `key: value` credentials, bearer tokens, common token prefixes). They are capped at 4096 chars with a `\n[truncated]` marker, per-field `…Truncated` flags and an event-level `truncated` flag. Assistant text and reasoning are never reported. `POST /activity` accepts externally built events, rejects unknown fields and re-caps content. With `activity.enabled: false` the drain stays valid and empty.

**Process hygiene.** The plugin never writes to stdout; everything goes through the DSH logger. Every async path is guarded. Disposal runs in this order. First the runtime: held wakes get 503, `SessionEnd` is queued and the agents are disposed. Then the bridge stops (SIGTERM, then SIGKILL after 2 s). Next, one `raft agent bridge --once` pass (poll mode, at most 5 s) forwards `SessionEnd`, so Raft shows the agent offline rather than ready. Last, the endpoint closes and timers are cleared.

## Channel mentions and Raft server delivery

An @mention of the agent in a channel can fail to reach it through `raft message check`, and sometimes through the wake hint as well. Two server-side defects cause this. Line numbers refer to the Raft server source the analysis used (`packages/server/src`):

1. **The inbox is per-process memory.** An external agent's inbox is an in-memory buffer on one server process (`services/agentOrchestrator.ts:2028`, `agentInboxes = new Map<string, AgentInbox>()`). `/internal/agent-api` requests have no replica affinity, so `/wake-hints` and `/events` (what `raft message check` reads) can hit different replicas and disagree. A message already acknowledged on one replica can also be re-delivered from another replica's buffer.
2. **#all is a virtual channel, but the durable paths join a real table.** The audience of #all is every agent on the server (`services/channelService.ts:3249-3255`, `getChannelAgents` → `getServerAudienceAgents`). The durable inbox rebuild (`services/messageService.ts:4304-4357`) and the ack-cursor advance (`markAgentLegacyAckCheckpoint`, `services/channelService.ts:15274-15297`) both join the `channel_agents` table, and a new agent has no #all row there. A top-level @mention in #all therefore lives only in the memory of the replica that accepted the send. On the live deployment one such mention was never delivered and another arrived only after 6.5 minutes.

A third behaviour limits the workaround. `raft message read` on the default (latest) page, and on `--before`/`--after` pages, marks the channel read up to the page's newest message (`routes/internalAgentApi.ts:2150-2162`, `markRead`, skipped only for `--around`). A plugin that polled history would advance `agent_channel_read_cursors` and could hide a pending mention from the durable rebuild for good.

**The mention sweep.** The plugin therefore does not depend on the inbox for mentions. Once at startup, after the session is attached, and then every `sweep.intervalMs`, it runs:

```
raft profile show --json                       # once, for the agent's handle and display name
raft message search --query "@<handle>" --sort recent --after <iso> --limit 50 [--offset <n>] [--target <t>]
```

`message search` is read-only: the agent-API handler (`routes/internalAgentApi.ts:4428`, `messageSearch`) moves no cursor, and its visibility set covers every public channel, #all included, without consulting `channel_agents` (`services/searchService.ts:846`). The CLI runs with the bridge's `raftBin` and `RAFT_PROFILE`/`SLOCK_PROFILE` (never the wake token), with a 10 s deadline per call. The plugin parses the CLI's text output (`<result ref="msg:<id>">`, `Source:`, `Sender:`, `Time:`, `<preview>`). A result is reported only when all of the following hold:

- its preview really contains `@<handle>`, because full-text search also returns messages that merely contain the words;
- it is not the agent's own message;
- its source is a channel (`#name`) or a channel thread (`#name:<thread>`); names may be any Unicode letters and digits, as Raft allows (`NAME_REGEX`, `packages/shared/src/index.ts:3390`). DM sources name the stored DM channel rather than the peer, so they are skipped; any other source the plugin cannot map is logged at warn level and not reported;
- it is newer than `max(plugin start − lookbackMs, watermark − 60 s)`;
- it is at least 30 s old. The wake hint and `check` usually deliver a mention within seconds; younger results are not judged (or counted in the watermark) until a later sweep;
- it is in neither the seen-set nor the set of short ids that the agent's own `raft message check` tool results returned. The plugin reads the `[target=… msg=<shortid> …]` headers of those results.

While the agent's own `check` may still deliver messages (a wake notice waits unclaimed, a wake-started turn has not run `check` yet, or a `check` call has not returned), new mentions are held for a later sweep instead of being reported, so a mention the normal path is delivering gets no second notice. A mention is held at most until it is 5 minutes old, so an agent that stays busy still hears about it.

Results come newest first, 50 per page. A full page is followed by the next one (`--offset`) until a short page, so a busy window cannot push older mentions past the watermark. When no message matches every query word, the server falls back to any-word matches on the first page only (`services/searchService.ts:724-727`); the second page is then empty and paging stops. Paging stops at 40 pages per target (as many results as the seen-set holds) with a warning that names the time before which mentions were not examined.

New mentions become one notice (source kind `user`). The notice carries no message content:

```
[Raft mention] You were mentioned and it may not appear in raft message check: #all message 0ffb9edf. Read it with `raft message read --target "#all" --around 0ffb9edf` and answer in that target if it still needs an answer.
```

With several mentions it lists five and ends with `+N more` plus a search hint. A mention notice still unclaimed when the next sweep finds more is replaced by one merged notice, so sweeps never stack notices. It moves with a rotation and is queued again after an external dispose. Wake coalescing does not apply to it, because `check` is exactly what may miss these messages. The orientation's rule 3 says to answer messages that check returned or that a `[Raft mention]` notice names. Rule 2 (read the target before replying; skip a message already answered) is the dedupe against both the server's re-delivery and a mention that check delivered after the sweep ran anyway.

The seen-set (the last 2000 ids), the checked short ids, the watermark (the newest handled mention time) and the mentions whose notice no turn has claimed yet live in `<DSH_HOME>/raft-channel/<profile>-mentions.json`, which is written atomically. A queued notice lives in the agent's inbox, which a plugin stop, restart or crash discards; the next process queues a notice for those unclaimed mentions at its first sweep, and a mention leaves that list once a turn claims its notice. The sweep never runs concurrently with itself. A CLI failure or timeout is logged at warn level and retried at the next interval, and a notice that could not be queued is retried too. The plugin sends nothing to Raft and writes nothing to stdout. `ctx.raftChannel.sweepMentions()` runs one sweep on demand; if one is still running when startup finishes, the startup sweep runs after it and the periodic schedule starts as usual. Limits: 40 pages of 50 results per target per sweep, and the preview window of about 200 characters around the first hit.

## Status

`ctx.raftChannel.status()` returns `{state, profile, endpoint, runtimeSession, turns, bridge, activityQueued, mentionSweep, error}`, and `ctx.raftChannel.whenReady()` resolves once startup completes.

## Development

```sh
pnpm install
npm run typecheck
npm test
npm run build       # lib/ is committed: rebuild before committing src changes
```

The tests run a real DSH agent loop, with JSONL persistence where needed, against a scripted model adapter. A fake `raft` executable (`tests/fixtures/fake-raft.mjs`) records argv/env, POSTs wakes, crashes, or reports fatal and mismatch errors. An optional live check starts the real bridge against the endpoint with activity off and bridge state in a scratch directory:

```sh
RAFT_LIVE_PROFILE=<slug> RAFT_LIVE_AGENT_ID=<agent id> npx vitest run tests/live-bridge.spec.ts
```

With `RAFT_LIVE_ACTIVITY=1` as well, a second check turns activity on. It waits for a real `/activity/drain` → server forward (the stream bridge drains on each server heartbeat, about every 25 s) and checks that the dispose flush forwards `SessionEnd`. This changes the Agent's activity shown in Raft.

## License

BSD-3-Clause
