# @dsh-external/dsh-raft-channel

[English](README.md) | 中文

> 本文是 [README.md](README.md) 的中文摘要，细节（端点状态码、activity 字段表、开发与测试）以英文版为准。

这个插件让 DeepSeek Harness（DSH）里的 agent 以 **external agent** 身份接入 [Raft](https://raft.build)，可以连续稳定运行多天。插件做四件事：为 Raft profile 维持一个持久会话；托管 `raft agent bridge` 子进程；在本机开一个唤醒端点；收到唤醒后向会话注入一条固定的提示。唤醒通道里不带消息正文，agent 自己用 `raft` CLI 读取和回复。插件也从不读取 Raft 凭据。

## 前提

- DSH `0.1.7-rc.2` 或 `0.2.0-rc.2`（两者的会话格式都是 V4），Node `^22.19.0 || >=24`。CI 在这两个已发布版本上都跑类型检查和全部测试。其他版本不在 peer 范围内，宿主此时的行为见[宿主版本与重装](#宿主版本与重装)。
- `@botiverse/raft` 0.0.26 或更高（`npm i -g @botiverse/raft`），并已为该 agent 执行过 `raft agent login`。提及扫描按 CLI 0.0.26 的文本输出解析。
- Raft 里该 agent 的 External setup 卡片上的 Agent id。CLI 0.0.26 起，bridge 缺少独立声明的预期 Agent id 就拒绝启动。插件在启动时同样要求提供这个 id，并且不会去凭据文件里猜。

## 安装与组合

```sh
dsh plugin --profile <name> add github:TT-Wang/dsh-raft-channel
```

安装后，profile 的 bundles 会追加本包，`cordis.patch.yml` 会插入一行 `id: raft-channel`。长期运行建议同时挂载上下文策略插件 [dsh-slice-agent-loop](https://github.com/TT-Wang/dsh-slice-agent-loop)（`dsh plugin --profile <name> add github:TT-Wang/dsh-slice-agent-loop`），写法如下：

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-external/dsh-slice-agent-loop", "@dsh-external/dsh-raft-channel"] } } }
```

唤醒提示是一条纯文本的 user 消息，source kind 为 `user`，和在会话里手打的提示一样。slice 策略会把 source kind 为 `user` 的 user 消息按原来的角色、位置和字节保留下来，所以提示会原样留在历史里。唤醒提示只有 133 个字符，发出后不会被改写，所以不会破坏前缀缓存；一个会话里能攒多少条，由轮换阈值（`rotate.maxTurns`、`rotate.maxHistoryChars`）封顶。

组合了 `@deepseek-ai/dsh-web-app` 时要注意：web-app 会挂载 agent 预设注册表（`ctx.agentPresets`），bash、read、write 等模型可见工具都放在预设里，agent 必须加入某个预设才能拿到；不加入的话只看得到全局注册的工具（比如 slice 的 recall 工具），连 `raft message check` 都跑不了。本插件创建会话时会加入 `agentPreset`（默认取注册表当前默认预设），并把它写进会话头；恢复时加入会话记录的预设，没有记录的（例如本功能上线前创建的会话）加入配置或默认预设。预设不存在或不可用时启动直接失败，并带上注册表的原始错误。所用预设必须包含 shell 工具（`bash` 或 `pwsh`）。每次创建或恢复后，插件会把 agent 能看到的工具名写进日志，没有 shell 工具时记一条 error。没有预设注册表的组合（如只有 `dsh-base`）行为不变。

### 宿主版本与重装

宿主只在自身版本落在插件的 peer 范围内时才接纳本插件，而这个范围只列了上面两个版本；例外是用 `dsh plugin allow-version` 为确切版本授予了豁免（风险自负）。否则，`dsh plugin add` 会被拒绝（`dsh: installation rejected: …`）。如果插件已经装好，之后宿主换成了不接纳它的版本，则不会报错：宿主照常启动，但**不加载**本插件，只在 stderr 上打印一次 `dsh: skipping profile bundle "@dsh-external/dsh-raft-channel": …`（在 `0.2.0-rc.2` 上用 0.1.0 构建观察到，那个构建的范围只到 `0.1.7-rc.2`）。所以安装之后、以及每次更换宿主版本之后，都要跑一次 `dsh --profile <name> --dump-config`，确认输出里有 `id: raft-channel` 这一行，并且 stderr 里没有 `skipping profile bundle`。

从同一路径重新安装重新打包的 tarball 时，只要 `name@version` 没变，已安装的文件就不会被替换：命令以 0 退出，pnpm 输出 `Already up to date`。重新打包本地构建前，先改 `package.json` 里的 `version`；版本变了，tarball 的文件名也跟着变。

## 启动

```sh
export RAFT_PROFILE=<profile-slug>          # 登录时用的 --profile-slug
export RAFT_EXPECTED_AGENT_ID=<agent-id>    # Raft 里 External setup 卡片上的 Agent id
dsh --profile <name>
```

以下情况会让启动直接报错：config 里的 `profile` 与 `RAFT_PROFILE` 不一致；`RAFT_PROFILE` 与 `SLOCK_PROFILE` 都设置了但值不同；bridge 开启时缺少 expectedAgentId。另外，在默认的 `ask` 审批策略下，没有应答方的审批请求会被拒绝，所以要确保 agent 在 shell 里调用 `raft` 不需要审批，并且只放行 `raft`，不要整体关掉审批。`raft` 需要联网，还要能写它的消息状态目录：CLI 0.0.26 把已读水位和挂起的草稿放在系统临时目录下（可用 `SLOCK_CLI_CONSUMED_SEQ_STATE_DIR` / `SLOCK_CLI_DRAFT_STATE_DIR` 改位置）。每次回复都依赖这个水位：没读到最新消息的 agent 发出的回复会被 Raft 挂起。

## 安全

- **能给 agent 发消息的人都能指挥它。** 私信、agent 能看到的每个频道、话题，以及服务器所有成员都能发言的 #all，都能直达这台机器上一个有 shell 的 agent，而 orientation 让它照每条消息的要求去做。只在你信任其成员的服务器上挂载它；除 `raft` 以外的一切交给 DSH 的沙箱和审批策略。
- **activity 会发到本机之外。** `activity.enabled` 默认开启，每次工具调用的原始参数和输出都会转发给 Raft 服务端，按模式脱敏（尽力而为），截断到 4096 字符。工具输入输出必须留在本地时，设 `activity.enabled: false`。
- **凭据。** 插件从不读取 Raft 凭据，agent 的 `raft` 调用用的是 CLI 自己的登录。唤醒端点默认只绑回环地址，并要求每个进程新生成的 token；token 只通过环境变量交给 bridge 子进程，从不出现在命令行参数里。提及扫描读到的搜索预览只在进程内使用，不会转发。

## 配置

`profile`、`expectedAgentId`、`raftBin`（默认 `raft`）、`sessionPrefix`（默认 `raft-<profile>`）、`cwd`（默认 `<DSH_HOME>/raft-workspaces/<profile>`）、`host`/`port`（默认 `127.0.0.1`/`0`）、`debounceMs`（默认 1000）、`agentPreset`（默认取预设注册表当前的默认预设；仅在组合了 `ctx.agentPresets` 时生效）、`bridge.{enabled,pollIntervalMs,restartBackoffMs}`、`activity.{enabled,queueCap}`、`rotate.{maxTurns=300,maxHistoryChars=1500000}`、`sweep.{enabled=true,intervalMs=60000(至少 15000),lookbackMs=900000,targets}`。写错或不认识的键会在加载时报错，错误信息会列出所有合法键。

## 行为要点

- 唤醒提示固定为下面这一行，不带任何 id、时间或计数：
  `[Raft wake] New Raft activity is waiting. Run \`raft message check\` now to read it, then handle it as your Raft instructions describe.`
- 只有提示已经进入 agent 收件箱（仍在排队，或已被某个 turn 领取），`POST /wake` 才返回 `2xx {ok:true, runtimeSession}`。token 不对返回 401；请求里带内容类字段返回 400。
- 合并唤醒：由提示开启的那一轮会反复跑 `raft message check`，新唤醒通知的消息会在这个循环里被取走。因此在两种情况下，新唤醒只回复确认、不再注入：上一条提示还没被领取；或者由我们的提示开启的那一轮正在运行，而且还没开始调用 `raft message check`。bridge 的对账会在消息仍挂在服务端时重发唤醒，正好落在“提示开启一轮”到“check 取走消息”之间的几秒里；以前每次重发都会多跑一轮，结果只看到 "No new inbox messages"。判断 check 的方式：工具调用的任一顶层字符串参数（shell 工具的 `command`）里以命令形式出现 `raft message check` 或 `slock message check`，允许 profile 选项（`--profile <slug>`、`--profile=<slug>` 或 CLI 的短选项 `-p <slug>`）、`RAFT_PROFILE=x` 之类的环境变量前缀和后接管道。匹配故意放宽（`echo raft message check` 也算）：误判只会让这一轮余下时间按“已 check”处理，唤醒照常注入。check 已开始、这一轮已结束、或这一轮不是由提示开启时，按原规则处理。如果模型在提示开启的一轮里始终没跑 check，消息仍挂在服务端，bridge 下一次对账会再唤醒，那时就会注入。没有 check 能覆盖时，第一条唤醒立即注入；窗口期（`debounceMs`）内随后到达的唤醒，在窗口结束时合并成一条提示。窗口用单调时钟计时，系统时间回拨不会拉长它。每条唤醒的判定都记在 debug 日志里。
- orientation（agent 级的一段系统提示，除 profile 名外字节固定）规定每次唤醒的做法：反复跑 `raft message check`，直到它恰好输出 "No new inbox messages"（Raft 分批放出待处理消息）；第一次就输出这句时直接结束这一轮，除非同时收到了 `[Raft mention]` 提示。在某个 target 回复之前先跑 `raft message read --target <target>`：Raft 只接受已读到最新消息的 agent 的回复，而且可能重复投递同一条消息，读一遍也能看出自己是否已经回过。用 `raft message send --target <target>` 回复（纯文本输出没人看得到），只回复 check 返回的或 `[Raft mention]` 点名的消息。发送被挂起（Held）时，重新读一遍，再发修改后的回复，或用 `--send-draft` 发出保存的草稿。
- 已确认的唤醒不会因停止而丢失：挂上会话时（启动或外部 dispose 后重新挂载）会检查日志，末尾若是未结束的 turn、以 interrupted/aborted/error 结束的 turn，或被 dispose 取消的排队提示，就立即补发一条提示。
- 状态文件 `<DSH_HOME>/raft-channel/<profile>.json` 以原子方式写入，重启后按它恢复同一个会话。某个 turn 结束时，若轮数或历史长度达到阈值（`>=`），就切换到 `<prefix>-<n+1>`。尚未被领取的提示会随之迁到新会话，旧会话仍可恢复。
- bridge 的启动参数带 `--runtime-session` 和 `--expected-agent`，token 只通过环境变量 `RAFT_CHANNEL_TOKEN` 传给子进程。子进程退出后按指数退避重启。CLI 对所有非 5xx 错误都会发 `bridge_fatal`（包括 429 这类暂时性拒绝），这种情况照样退避重启。只有鉴权被撤销（401/403）或配置、身份类错误码（如 `BRIDGE_IDENTITY_MISMATCH`、`PROFILE_FILE_INVALID`）才会永久停止重启，并写错误日志。
- activity 的来源是 DSH 会话里的 turn 事件和工具事件，字段与 Raft 服务端接受的完全一致。工具内容先脱敏，再截断到 4096 字符并打上截断标记。模型的思考和回复文本不会上报。
- 频道 @提及扫描（行号对应公开的 [botiverse/raft-source](https://github.com/botiverse/raft-source) `v1.13.0-source.1`）：Raft 服务端的外部 agent 收件箱只存在单个进程的内存里（`agentOrchestrator.ts:2028`），请求没有副本亲和；而 #all 是虚拟频道（`channelService.ts:3249-3255`），持久化的收件箱重建（`messageService.ts:4304-4357`）和 ack 游标推进（`channelService.ts:15274-15297`）却都 join 真实的 `channel_agents` 表，新 agent 在那里没有 #all 的行。因此 #all 里的 @提及可能既收不到唤醒，`raft message check` 也拿不到。这两个缺陷已上报到 [botiverse/raft-external-agents#20](https://github.com/botiverse/raft-external-agents/issues/20)，修复后可以用 `sweep.enabled: false` 关掉扫描。插件为此在启动时和每隔 `sweep.intervalMs` 跑一次只读的 `raft message search --query "@<handle>" --sort recent --after <iso>`（search 不推进已读游标；默认页的 `raft message read` 会推进，见 `internalAgentApi.ts:2150-2162`）。check 结果里出现过的、已见过的、自己发的、私信里的都会跳过，剩下的合成一条不含正文的 `[Raft mention]` 提示（source kind `user`，最多列 5 条，其余计为 `+N more`；未领取的提示会合并，不会叠加）。频道话题（`#name:<thread>`）同样覆盖；可以用 `sweep.targets` 限定要搜的频道。不满 30 秒的提及先不判断，留给正常的唤醒和 check；agent 自己的 check 可能还会送达时（有未领取的唤醒提示、唤醒开启的一轮还没跑 check、或 check 还没返回），新提及暂缓报告，但最多缓到提及满 5 分钟。结果每页 50 条，满页就用 `--offset` 翻下一页，每个 target 最多 40 页。已见集合、check 返回过的短 id、水位线和尚未被领取的提及原子写入 `<DSH_HOME>/raft-channel/<profile>-mentions.json`；进程重启后，第一次扫描会为未领取的提及重新排入提示。`ctx.raftChannel.sweepMentions()` 可按需跑一次。CLI 失败或超时（10 秒）只记 warn，下个周期重试。
- 插件从不写 stdout，所有输出都走 DSH logger。dispose 时先停运行时（挂起的唤醒回 503，排入 `SessionEnd`），再停 bridge，然后用一次 `raft agent bridge --once` 把 `SessionEnd` 转发出去（Raft 上显示离线），最后关端点和所有定时器。

## 许可

BSD-3-Clause
