# DSH 0.2.1 compatibility

Plugin version **0.1.2** targets DSH **0.2.1-rc.2** and also supports **0.2.0-rc.2**. On 2026-10-22, npm's `latest` and `next` tags for `@deepseek-ai/dsh` both resolved to 0.2.1-rc.2 (published 2026-10-17), and `alpha` resolved to 0.2.1-alpha.5, which this build does not admit. The development dependencies pin 0.2.1-rc.2 exactly. All seven `@deepseek-ai/dsh-*` peers carry the exact list `0.2.0-rc.2 || 0.2.1-rc.2`.

0.2.0-rc.2 stays in the range because the live deployment runs it and must be able to roll back without repacking. Read [Session data across hosts](#session-data-across-hosts) before relying on that: the plugin admits both hosts, but a session written by 0.2.1 does not always open on 0.2.0. 0.1.7-rc.2 is no longer admitted. The last build that admits it is 0.1.1 (main at `f27b878`).

Plugin source and `lib/` did not change. The bump changes `package.json`, `pnpm-lock.yaml`, the test harness, CI and the docs.

## What the 0.1.1 build does on a 0.2.1 host

The 0.1.1 build lists `0.1.7-rc.2 || 0.2.0-rc.2`, so a 0.2.1-rc.2 host refuses it:

- `dsh plugin add` of the 0.1.1 tarball exits 1 with `dsh: installation rejected: Plugin @dsh-external/dsh-raft-channel@0.1.1 is incompatible with dsh 0.2.1-rc.2: requirements {…}` and restores the profile's `package.json`, lockfile and `node_modules`.
- A profile that already has 0.1.1 installed still starts on 0.2.1-rc.2. `--dump-config` exits 0, the composed tree has no `raft-channel` row, and stderr has one line, `dsh: skipping profile bundle "@dsh-external/dsh-raft-channel": …`. A running host in that state serves its UI, but the agent never comes online in Raft.

## What changed for the plugin between 0.2.0-rc.2 and 0.2.1-rc.2

This section was read from the upstream tags `dsh-v0.2.0-rc.2` and `dsh-v0.2.1-rc.2` (`687f282`) and their upgrade guides on 2026-10-22, then checked against the published packages.

### Peer admission

For a package without `engines.dsh`, the admission rule did not change. At install and at profile load, the host checks every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer range against its own version with `semver.satisfies` and `includePrerelease`. A bundle with any unmet range is skipped, and the host prints only that one stderr line.

Two details are new in 0.2.1 (`packages/boot/app-boot/src/plugin-compatibility.ts`, upgrade guide `v0.2.1-alpha.3/plugin-engines-dsh`):

- A package that declares `engines.dsh` is judged by that range alone, and its DSH peers are then ignored. This package declares only `engines.node`, so the peer rule still applies. Adding `engines.dsh` would help only if it named the same hosts as the peers: 0.2.0 hosts ignore it, and `pnpm peers check` and `tests/manifest.spec.ts` only read peers.
- The refusal text names the unmet ranges `requirements {…}` instead of `peerDependencies {…}`. The prefixes `dsh: installation rejected:`, `dsh: skipping profile bundle` and `dsh: disabling profile plugin` are unchanged, so checks should match on those.

The range stays an exact list. Under the host's rule a caret range such as `^0.2.0-rc.2` would also admit 0.2.1 alphas.

### Test harness: runtime invariants are gone

0.2.1 publishes neither `@deepseek-ai/dsh-invariants` nor any `<package>/invariant` subpath (upgrade guide `v0.2.0-rc.2/remove-runtime-invariants`). npm has no 0.2.1 version of `@deepseek-ai/dsh-invariants`; its `next` tag is still 0.2.0-rc.2. `tests/harness.ts` imported and mounted three of them: `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-session/invariant` and `@deepseek-ai/dsh-agent-loop/invariant`. On 0.2.1 the two subpaths fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` and the package with `ERR_MODULE_NOT_FOUND`. With only the pins moved, `tsc -p tsconfig.test.json` reported TS2307 for the three imports, and 8 of the 11 spec files failed to load (`"./invariant" is not exported`). Only the 16 tests in `activity`, `config` and `manifest` ran.

The imports, the three mounts and the devDependency are removed, and nothing replaces them. Upstream removed the checks without a successor, and the guide tells plugins to delete the rows and imports. The checks covered host code only: the session invariant checked the shape of the event log, and the agent-loop invariant checked that each loop-built request equals the session's derived messages and folded request header. This plugin appends no session events and never builds or edits a request. It queues inbox messages through the agent API and reads the log. On 0.2.0-rc.2 the harness now also runs without the checks.

### Test harness: JSONL persistence export shape

`@deepseek-ai/dsh-session-persistence-jsonl` 0.2.1-rc.2 has no default export. The module namespace itself is the plugin (`name`, `Config`, `apply`), and the class is private (upgrade guide `v0.2.1-alpha.1/jsonl-persistence-plugin`). On 0.2.0-rc.2 the plugin is still the default-exported class. On 0.2.1 the old default import fails the type check with TS1192 (`has no default export`). Cordis does not unwrap `default`, so a plain default import works only on 0.2.0 and a plain namespace import only on 0.2.1. The harness imports the namespace and takes `default` when it exists:

```ts
import * as JsonlModule from '@deepseek-ai/dsh-session-persistence-jsonl'
const JsonlPersistence = ((JsonlModule as { default?: unknown }).default ?? JsonlModule) as Plugin<{ root: string; compression: 'none' }>
```

Plugin source never mounts persistence. It only checks whether `ctx.get('sessionPersistence')` is present.

### Cordis pins and `pnpm peers check`

The 0.2.1-rc.2 packages peer on `@deepseek-ai/cordis ~4.0.5`, `cordis-plugin-group ~1.0.5`, `cordis-plugin-include ~1.0.10` and `cordis-plugin-loader ~1.0.6`. With only the DSH pins moved, `pnpm peers check` fails. The four cordis devDependencies therefore move to 4.0.5, 1.0.5, 1.0.10 and 1.0.6, all published 2026-10-16. The 0.2.0-rc.2 packages' ranges (`~4.0.4`, `~1.0.4`, `~1.0.9`, `~1.0.5`) admit the same pins, so the CI leg for 0.2.0-rc.2 keeps them. The plugin's own peer `@deepseek-ai/cordis: ~4.0.4` is unchanged. It admits both hosts' cordis, and host admission ignores cordis.

### Lockfile

The lockfile was regenerated in place (`pnpm install --no-frozen-lockfile` over the committed one). On the DSH side every package moves from 0.2.0-rc.2 to 0.2.1-rc.2, `dsh-invariants` leaves, and two packages arrive as auto-installed peers: `dsh-working-directory` (a new peer of `dsh-tools`) and `dsh-fs` (a peer of `dsh-working-directory`). Outside DSH, the changes are: cordis 4.0.4 to 4.0.5, cordis-plugin-group 1.0.4 to 1.0.5, cordis-plugin-include 1.0.9 to 1.0.10, cordis-plugin-loader 1.0.5 to 1.0.6, cosmokit 1.8.5 to 1.8.6, schemastery 3.18.4 to 3.18.5, and node-addon-native-custom-loader and node-addon-require-builtin 0.1.6 to 0.1.9, which adds two linux musl variants. zod 4.4.3, p-limit 7.3.3 and yocto-queue 1.2.2 are new; zod 4.6.5 stays as well. koffi stays at 3.1.1, and no new build script needs approval.

`minimumReleaseAgeExclude` stays empty. Every pinned release was at least five days old when this change was made, and pnpm added no exemptions.

### Plugin source: no change

`src/` typechecks against the published 0.2.1-rc.2 declarations, and a rebuild reproduces the committed `lib/` byte for byte. The APIs the plugin uses kept their shape between the tags. These include `agents.create`, `resume`, `get` and `followup`, `inbox.nextTurn` and `remove`, `whenIdle`, `installModelSelection`, the `agent/inbox/claimed` and `agent/disposed` events, `section({ interpolate: false })`, the agent-preset registry's `defaultId`, `resolve`, `acquireScope` and `mount`, `workspace.create(path).attachSession`, `resolveDshHome`, and `Session.snapshotEvents()` and `deriveMessages()`. `snapshotEvents()` is still marked deprecated and still works. `SESSION_FORMAT_VERSION` is 4 on both hosts.

## What the agent sees on 0.2.1

These are host composition changes. None of them needs a plugin change. The figures come from a smoke run during the investigation on 2026-10-22: the published hosts, dsh-base plus dsh-web-app as in the deployment, a scripted model, and a fake `raft` executable instead of the bridge.

- **Tools.** The web `standard` preset gains `schedule_create`, `schedule_delete`, `schedule_list`, `schedule_update` and `working_directory`: 31 tools on 0.2.1-rc.2 against 26 on 0.2.0-rc.2, with none removed. With dsh-base alone the agent sees 25.
- **System prompt.** The line `Your working directory is …` is gone, because 0.2.1 drops the `{{cwd}}` prompt variable. The paragraphs naming the Harness checkout and the Web GUI URL move from the system prompt into the runtime context. The `raft:orientation` section is byte-identical on both hosts. It uses `interpolate: false` and never used `{{cwd}}`.
- **Runtime context and clock.** The runtime-context snapshot now always starts with `Current working directory: "…"`. Some turns start with a new user-role `time-context` message (`Time sampled while preparing turn …`), at most every 10 minutes by default.
- **Working directory.** The shell tool takes its directory from the new working-directory service instead of the session header, and the agent can change it with `working_directory`. The plugin still creates sessions with `meta.cwd` set to the `cwd` option and lists them in the workspace registry under the header's `cwd`. In the smoke run the service's directory equalled the header's and no `working-directory/change` event was written. The shell tool's `command` is still a top-level string argument, so check detection still works: the smoke logged `turn 2 started raft message check`.
- **First resume after the upgrade.** A session written by 0.2.0 resumes on 0.2.1 and keeps its old system-prompt paragraphs until the host replaces them. Its first request carries a new tools header, which misses the provider cache once, and the log gains a permanent tool-registry `developer/message` for the added tools.
- **With the slice policy.** The time-context readings are user messages that slice did not write. They stay raw at their nodes and count toward `rotate.maxHistoryChars`.
- **Schedules.** The agent can now create schedules that start turns without a wake. The plugin tracks only turns that its own notices start, so a scheduled turn is handled like any turn the plugin did not start.

## Session data across hosts

- **Forward (0.2.0 to 0.2.1).** A 0.2.1 host resumes sessions that 0.2.0 wrote, and the plugin continues the same `<prefix>-<n>` session. In the investigation smoke a session written by 0.2.0-rc.2 resumed on 0.2.1-rc.2 and went from one turn to two.
- **Back (0.2.1 to 0.2.0).** 0.2.1 writes `job/registered` and `job/settled` events for every shell call, foreground calls included. These events are not marked ignorable, and 0.2.0-rc.2 refuses a log with event types it does not know. In the investigation smoke, a home that had run one wake turn on 0.2.1-rc.2 was started on 0.2.0-rc.2. The plugin logged `raft-channel: cannot resume raft-probe-1 (session "raft-probe-1" contains event type "job/registered" (seq 19) unknown to this harness and not marked ignorable; …); continuing in a new session`, created `raft-probe-2` and queued a fresh wake notice. The turn then completed. The plugin did what its resume rules say for an unreadable session; no code change is needed. The old session stays on disk and opens again on 0.2.1.
- **What to do.** Before the first start on 0.2.1, back up `<DSH_HOME>/sessions` and `<DSH_HOME>/raft-channel/<profile>.json`. A rollback that must keep the agent's history restores both and loses the turns run on 0.2.1. A raft rotation on 0.2.1 creates sessions that 0.2.0 cannot open either.

## Verification recorded on 2026-10-22

Machine: macOS 26.5 arm64, Node 22.22.3, pnpm 11.7.0. Plugin: version 0.1.2 at commit `12e39ad`. This section was added in the next commit, which changes only this file. Every type check and test run below ran under `sandbox-exec` with reads of the scratch directory's ancestor `node_modules` denied, so no package could load from an older copy (see [Before the next host bump](#before-the-next-host-bump)).

| Check | Host | Result |
| --- | --- | --- |
| CI job `published-dsh`, replayed from a fresh clone: `pnpm install --frozen-lockfile`, `pnpm peers check`, `typecheck`, tests, rebuild and `lib/` drift check | published 0.2.1-rc.2 packages | all passed; **126 passed, 2 skipped across 11 files** (the skips are the opt-in live-bridge tests); `No peer dependency issues found`; rebuilt `lib/` identical to the committed files |
| CI job `previous-dsh`, replayed from a fresh clone: DSH devDependencies repointed, `pnpm install --no-frozen-lockfile`, `pnpm peers check`, `typecheck`, tests | published 0.2.0-rc.2 packages, cordis 4.0.5 | all passed; **126 passed, 2 skipped across 11 files**; a rebuild there also reproduced the committed `lib/` |
| Same test suite on Node 25.6.0 (not a CI node) | published 0.2.1-rc.2 packages | 126 passed, 2 skipped |
| Pins moved, test harness unchanged | published 0.2.1-rc.2 packages | TS2307 for the three invariant imports and TS1192 for the JSONL default import; 8 of 11 spec files failed to load, 16 tests ran |
| `npm pack` | n/a | `dsh-external-dsh-raft-channel-0.1.2.tgz`, 25 files, 65.5 kB packed, 209.1 kB unpacked, SHA-256 `023765184b9f1fa6ae3a0973f0f46be61385176b73908bcdaea50b56665896cf` |

The digest identifies this build only. A change to `lib/`, `package.json`, a README or `LICENSE` changes it; this file is not in the tarball.

Admission was checked with `dsh plugin --profile raft-admit add <tarball>` followed by `dsh --profile raft-admit --dump-config`, in a new scratch `DSH_HOME` per run. The profile mirrored the live one: bundles `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, `nodeLinker: hoisted`, `autoInstallPeers: false`, an empty `cordis.patch.yml`. The profile was never started. The 0.2.1-rc.2 CLI came from `npm install @deepseek-ai/dsh@0.2.1-rc.2` in a scratch directory. The 0.2.0-rc.2 CLI was the live deployment's own host binary, run with the scratch `DSH_HOME`; no file under that host directory changed.

| Build | Host CLI | `plugin add` | `--dump-config` |
| --- | --- | --- | --- |
| 0.1.2 | 0.2.1-rc.2 | exit 0, installed 0.1.2 | exit 0, empty stderr, one `- id: raft-channel` row (191 top-level rows) |
| 0.1.2 | 0.2.0-rc.2 | exit 0, installed 0.1.2 | exit 0, empty stderr, one `- id: raft-channel` row (184 top-level rows) |
| 0.1.1 | 0.2.1-rc.2 | exit 1, `installation rejected: … requirements {…}`, profile restored | exit 0, empty stderr, no row |
| 0.1.1, installed with the 0.2.0-rc.2 CLI | 0.2.1-rc.2 (start only) | n/a | exit 0, no row, one `skipping profile bundle "@dsh-external/dsh-raft-channel"` line |
| 0.1.2 over that 0.1.1 install | 0.2.1-rc.2 | exit 0, installed 0.1.2, still one bundle entry | exit 0, empty stderr, one row |

For each dump the live launcher's checks (described under [Deploying this build](#deploying-this-build)) were applied to the raft-channel row. Both 0.1.2 runs and the upgraded profile pass. The 0.1.1 profile started on 0.2.1 fails on the `skipping profile bundle` line, which is the path where the launcher exits 78.

No release-age exemption was needed. `minimumReleaseAgeExclude` is empty, and every install above ran with `minimumReleaseAge: 1440`.

The figures in [What the agent sees on 0.2.1](#what-the-agent-sees-on-021) and [Session data across hosts](#session-data-across-hosts) come from the investigation smoke runs on the same day. They used the same source and lib, with the peer list `0.1.7-rc.2 || 0.2.0-rc.2 || 0.2.1-rc.2` under version 0.1.2. They were not repeated for this record, because they start the profile.

Not covered by this record: CI on Linux and on Node 22.19.0 and 24.x has not run this change yet. No model was called, no real Raft server or bridge was used, and the composition with a slice build that admits 0.2.1 was not checked here.

## Deploying this build

- **Install under the new name and version.** `npm pack` names this build `dsh-external-dsh-raft-channel-0.1.2.tgz`. Re-adding a tarball whose `name@version` is already installed does not replace the installed files. Installing 0.1.2 over 0.1.1 replaces them; the last row of the admission table checked that with the 0.2.1-rc.2 CLI. Keep the 0.1.1 tarball as a fallback. A host rollback does not need it, because 0.1.2 also admits 0.2.0-rc.2.
- **Replace both plugins before the first start on 0.2.1.** The live profile also carries dsh-slice-agent-loop 0.2.0, whose range stops at 0.2.0-rc.2. Stop the host, add 0.1.2 and a slice build that admits 0.2.1-rc.2 (0.3.0) with the 0.2.1-rc.2 CLI and `DSH_HOME` set to the deployment's home, switch the host, then start. Whichever of the two you add first, `plugin add` exits 0 but prints `dsh: warning: Plugin @dsh-external/<other>@<old version> is incompatible with dsh 0.2.1-rc.2: requirements {…}` and `dsh: it stays installed but profile startup denies it …` about the other, still-old plugin. Those lines are expected until both are replaced; the second `plugin add` prints none.
- **Or put 0.1.2 in ahead of the window.** 0.1.2 can be added with the 0.2.0-rc.2 CLI in a separate stop and start on 0.2.0-rc.2. Next to slice 0.2.0 it composes on 0.2.0-rc.2 and passes the launcher's checks, and `plugin add` prints no warning. The 0.2.1 window then only has to cover slice and the host switch. These orders were checked with `--dump-config`; adding a plugin while the host runs was not tested.
- **Fixing raft-channel alone is not enough.** On 0.2.1-rc.2 the host skips slice 0.2.0 (`dsh: skipping profile bundle "@dsh-external/dsh-slice-agent-loop": … requirements {…}`), so the deployment launcher exits 78 on every start, the supervisor keeps restarting it with a backoff that grows to 300 s, and the agent stays offline in Raft. A start that bypasses the launcher would run without the context policy.
- **Back up session data first.** Save `<DSH_HOME>/sessions` and `<DSH_HOME>/raft-channel/<profile>.json` before the first start on 0.2.1. Without them, a rollback starts a new Raft session (see [Session data across hosts](#session-data-across-hosts)).
- **The launcher's checks still hold.** The deployment launcher refuses to start the host unless `--dump-config` exits 0, its output contains neither `skipping profile bundle` nor `disabling profile plugin`, and each plugin row appears as `- id: <row>` at column 0. These strings are unchanged at both tags (`packages/boot/app-boot/src/profile.ts:120` and `compatibility-preflight.ts:82`), and the 0.2.1 dump prints rows in the same form. The admission runs above show the check passing for 0.1.2 on both hosts and catching 0.1.1 on 0.2.1. Only the launcher's host default and its comment name 0.2.0-rc.2. They change when the 0.2.1 host is installed next to the old one.
- **Decide the composition before the switch.** On 0.2.1 the agent gains `working_directory` and the `schedule_*` tools, and clock readings in its history. A profile patch can disable `tool-working-directory`. `time-context` and `tool-schedule` live inside the preset configuration, so a top-level row override does not reach them.
- **After the start,** check the host's stderr log for `skipping profile bundle` and `disabling profile plugin`, and check that Raft shows the agent online after the first wake.

## Before the next host bump

Do the same steps in one change: move the `@deepseek-ai/dsh-*` peers and devDependencies, check the cordis peer ranges of the new packages against the cordis devDependencies with `pnpm peers check`, regenerate the lockfile in place, rename the two CI jobs and repoint the second one, update `minimumReleaseAgeExclude` if the release is under a day old, bump `version`, and update both READMEs and this kind of note. `tests/manifest.spec.ts` fails when the installed DSH version is missing from the peer list, in both CI jobs. Packages that upstream removes show up as `ERR_MODULE_NOT_FOUND` or `ERR_PACKAGE_PATH_NOT_EXPORTED` in the test run.

When checking a host bump from a directory that has a `node_modules` above it, such as a scratch directory inside another checkout, run the type check and tests in a way that cannot resolve packages from there. Otherwise a package that the new host removed can still load from the ancestor's older copy, and the run passes when it should fail. On macOS, `sandbox-exec` with a profile that denies reads of those directories works. Call the tools directly (`./node_modules/.bin/tsc`, `./node_modules/.bin/vitest`, or `pnpm run`). `npm run` fails inside such a sandbox with `spawn EPERM`, because it puts every ancestor `node_modules/.bin` on `PATH`.
