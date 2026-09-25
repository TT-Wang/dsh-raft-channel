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
| `bridge.enabled` | `true` | Spawn and supervise the bridge |
| `bridge.pollIntervalMs` | CLI default | `--poll-interval-ms` |
| `bridge.restartBackoffMs` | `[1000, 60000]` | First and maximum restart delay |
| `activity.enabled` | `true` | Report activity through the drain |
| `activity.queueCap` | `500` | Bounded queue; oldest dropped and counted |
| `rotate.maxTurns` | `300` | Rotate once a turn ends with this many turns |
| `rotate.maxHistoryChars` | `1500000` | …or with this many chars of serialized model-visible history |

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

**Coalescing.** A wake that arrives while an earlier notice is still unclaimed in the inbox is acknowledged without a new notice, because that notice's check drains everything. When no notice is waiting, the first wake is injected at once. Wakes that follow within `debounceMs` are merged: they get one notice when the window closes, and each of their POSTs is answered then. The window runs on a monotonic clock, so a wall-clock correction cannot stretch it.

**Acknowledged wakes survive a stop.** Disposing an agent cancels a notice still queued in its inbox and interrupts a running turn. Whenever the plugin attaches a session (at startup, or when re-attaching after an external dispose), it reads the log. If the latest outcome is an open turn, a turn ended `interrupted`/`aborted`/`error`, or queued input canceled by a dispose, it queues one fresh notice at once. The bridge's reconciliation would otherwise take up to about two minutes. A POST still held by the debounce window at disposal is answered `503 no_session`, so the bridge keeps that hint.

**Orientation.** One agent-scoped system-prompt section, `raft:orientation`. It is byte-stable except for the profile slug and covers: identity (`raft profile show`); reading `raft manual get raft-cli-overview --intent … --reason …`; message bodies only via `raft message check`/`read`; every reply via `raft message send --target <source target>`, because plain text reaches nobody; claiming work with `raft task claim`; earlier conversation lives in Raft (`raft message read`/`search`); never printing or relaying credentials.

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

## Status

`ctx.raftChannel.status()` returns `{state, profile, endpoint, runtimeSession, turns, bridge, activityQueued, error}`, and `ctx.raftChannel.whenReady()` resolves once startup completes.

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
