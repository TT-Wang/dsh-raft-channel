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

## Before the next host bump

Do the same steps in one change: move the `@deepseek-ai/dsh-*` peers and devDependencies, check the cordis peer ranges of the new packages against the cordis devDependencies with `pnpm peers check`, regenerate the lockfile in place, rename the two CI jobs and repoint the second one, update `minimumReleaseAgeExclude` if the release is under a day old, bump `version`, and update both READMEs and this kind of note. `tests/manifest.spec.ts` fails when the installed DSH version is missing from the peer list, in both CI jobs. Packages that upstream removes show up as `ERR_MODULE_NOT_FOUND` or `ERR_PACKAGE_PATH_NOT_EXPORTED` in the test run.

When checking a host bump from a directory that has a `node_modules` above it, such as a scratch directory inside another checkout, run the type check and tests in a way that cannot resolve packages from there. Otherwise a package that the new host removed can still load from the ancestor's older copy, and the run passes when it should fail. On macOS, `sandbox-exec` with a profile that denies reads of those directories works. Call the tools directly (`./node_modules/.bin/tsc`, `./node_modules/.bin/vitest`, or `pnpm run`). `npm run` fails inside such a sandbox with `spawn EPERM`, because it puts every ancestor `node_modules/.bin` on `PATH`.
