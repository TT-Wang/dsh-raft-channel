# @dsh-external/dsh-raft-channel

[English](README.md) | 中文

这个插件让 DeepSeek Harness（DSH）里的 agent 以 **external agent** 身份接入 [Raft](https://raft.build)，可以连续稳定运行多天。插件做四件事：为 Raft profile 维持一个持久会话；托管 `raft agent bridge` 子进程；在本机开一个唤醒端点；收到唤醒后向会话注入一条固定的提示。消息正文不经过这个插件，agent 自己用 `raft` CLI 读取和回复。插件也从不读取 Raft 凭据。

## 前提

- DSH `0.1.7-rc.1` 或 `0.1.7-rc.2`，Node `^22.19.0 || >=24`。
- `@botiverse/raft` 0.0.26 或更高，并已为该 agent 执行过 `raft agent login`。
- Raft 设置卡片上的 Agent id。CLI 0.0.26 起，bridge 缺少独立声明的预期 Agent id 就拒绝启动。插件在启动时同样要求提供这个 id，并且不会去凭据文件里猜。

## 安装与组合

```sh
dsh plugin --profile <name> add github:TT-Wang/dsh-raft-channel
```

安装后，profile 的 bundles 会追加本包，`cordis.patch.yml` 会插入一行 `id: raft-channel`。长期运行建议同时挂载 `@dsh-external/dsh-slice-agent-loop`，写法如下：

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-external/dsh-slice-agent-loop", "@dsh-external/dsh-raft-channel"] } } }
```

唤醒提示是一条纯文本的 user 消息，source kind 为 `user`。这是有意为之：slice 策略只封存这一类消息，换成其他 kind，每条提示都会原样留在之后的每次请求里。

组合了 `@deepseek-ai/dsh-web-app` 时要注意：web-app 会挂载 agent 预设注册表（`ctx.agentPresets`），bash、read、write 等模型可见工具都放在预设里，agent 必须加入某个预设才能拿到；不加入的话只看得到全局注册的工具（比如 slice 的 recall 工具），连 `raft message check` 都跑不了。本插件创建会话时会加入 `agentPreset`（默认取注册表当前默认预设），并把它写进会话头；恢复时加入会话记录的预设，没有记录的（例如本功能上线前创建的会话）加入配置或默认预设。预设不存在或不可用时启动直接失败，并带上注册表的原始错误。所用预设必须包含 shell 工具（`bash` 或 `pwsh`）。每次创建或恢复后，插件会把 agent 能看到的工具名写进日志，没有 shell 工具时记一条 error。没有预设注册表的组合（如只有 `dsh-base`）行为不变。

## 启动

```sh
export RAFT_PROFILE=slicey-dsh
export RAFT_EXPECTED_AGENT_ID=<Agent id>
dsh --profile <name>
```

以下情况会让启动直接报错：config 里的 `profile` 与 `RAFT_PROFILE` 不一致；`RAFT_PROFILE` 与 `SLOCK_PROFILE` 都设置了但值不同；bridge 开启时缺少 expectedAgentId。另外，在默认的 `ask` 审批策略下，没有应答方的审批请求会被拒绝，所以要确保 agent 在 shell 里调用 `raft` 不需要审批。

## 配置

`profile`、`expectedAgentId`、`raftBin`（默认 `raft`）、`sessionPrefix`（默认 `raft-<profile>`）、`cwd`（默认 `<DSH_HOME>/raft-workspaces/<profile>`）、`host`/`port`（默认 `127.0.0.1`/`0`）、`debounceMs`（默认 1000）、`agentPreset`（默认取预设注册表当前的默认预设；仅在组合了 `ctx.agentPresets` 时生效）、`bridge.{enabled,pollIntervalMs,restartBackoffMs}`、`activity.{enabled,queueCap}`、`rotate.{maxTurns=300,maxHistoryChars=1500000}`。写错或不认识的键会在加载时报错，错误信息会列出所有合法键。

## 行为要点

- 唤醒提示固定为下面这一行，不带任何 id、时间或计数：
  `[Raft wake] New Raft activity is waiting. Run \`raft message check\` now to read it, then handle it as your Raft instructions describe.`
- 只有提示已经进入 agent 收件箱（仍在排队，或已被某个 turn 领取），`POST /wake` 才返回 `2xx {ok:true, runtimeSession}`。token 不对返回 401；请求里带内容类字段返回 400。
- 合并唤醒：一次 `raft message check` 会取走该 agent 所有待处理消息。因此在两种情况下，新唤醒只回复确认、不再注入：上一条提示还没被领取；或者由我们的提示开启的那一轮正在运行，而且还没开始调用 `raft message check`。bridge 的对账会在消息仍挂在服务端时重发唤醒，正好落在“提示开启一轮”到“check 取走消息”之间的几秒里；以前每次重发都会多跑一轮，结果只看到 "No new inbox messages"。判断 check 的方式：工具调用的任一顶层字符串参数（shell 工具的 `command`）里以命令形式出现 `raft message check` 或 `slock message check`，允许 `--profile <slug>`、`RAFT_PROFILE=x` 之类的环境变量前缀和后接管道。匹配故意放宽（`echo raft message check` 也算）：误判只会让这一轮余下时间按“已 check”处理，唤醒照常注入。check 已开始、这一轮已结束、或这一轮不是由提示开启时，按原规则处理。如果模型在提示开启的一轮里始终没跑 check，消息仍挂在服务端，bridge 下一次对账会再唤醒，那时就会注入。没有 check 能覆盖时，第一条唤醒立即注入；窗口期（`debounceMs`）内随后到达的唤醒，在窗口结束时合并成一条提示。窗口用单调时钟计时，系统时间回拨不会拉长它。每条唤醒的判定都记在 debug 日志里。
- 已确认的唤醒不会因停止而丢失：挂上会话时（启动或外部 dispose 后重新挂载）会检查日志，末尾若是未结束的 turn、以 interrupted/aborted/error 结束的 turn，或被 dispose 取消的排队提示，就立即补发一条提示。
- 状态文件 `<DSH_HOME>/raft-channel/<profile>.json` 以原子方式写入，重启后按它恢复同一个会话。某个 turn 结束时，若轮数或历史长度超过阈值，就切换到 `<prefix>-<n+1>`。尚未被领取的提示会随之迁到新会话，旧会话仍可恢复。
- bridge 的启动参数带 `--runtime-session` 和 `--expected-agent`，token 只通过环境变量 `RAFT_CHANNEL_TOKEN` 传给子进程。子进程退出后按指数退避重启。CLI 对所有非 5xx 错误都会发 `bridge_fatal`（包括 429 这类暂时性拒绝），这种情况照样退避重启。只有鉴权被撤销（401/403）或配置、身份类错误码（如 `BRIDGE_IDENTITY_MISMATCH`、`PROFILE_FILE_INVALID`）才会永久停止重启，并写错误日志。
- activity 的来源是 DSH 会话里的 turn 事件和工具事件，字段与 Raft 服务端接受的完全一致。工具内容先脱敏，再截断到 4096 字符并打上截断标记。模型的思考和回复文本不会上报。
- 插件从不写 stdout，所有输出都走 DSH logger。dispose 时先停运行时（挂起的唤醒回 503，排入 `SessionEnd`），再停 bridge，然后用一次 `raft agent bridge --once` 把 `SessionEnd` 转发出去（Raft 上显示离线），最后关端点和所有定时器。

完整说明见 [README.md](README.md)。
