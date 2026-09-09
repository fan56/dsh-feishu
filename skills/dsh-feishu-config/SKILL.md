---
name: dsh-feishu-config
description: "dsh 飞书机器人插件（@aiwayds/dsh-feishu）使用与配置指南。凡涉及飞书/Lark 接入、机器人配对、手机端控制 dsh、卡片交互、后台推送，或要配置 feishu 时先读本指南：cordis.patch.yml 挂载块 config: 段 12 键（mode/domain/operators/appId/appSecret/凭据 refs/statusIntervalMs/bodySegmentChars/resumeListStyle/btwContextMessages/backgroundPush）、DSH_FEISHU_* 环境变量、ask_user_question 配置向导、operators 空则 bot 休眠、settings.yaml dsh-feishu: 段是运行态非配置。触发词：飞书、feishu、lark、机器人、operators、配对、绑定、backgroundPush。"
---

# dsh-feishu 使用指南（飞书 / Lark 手机端驾驶 dsh）

> 把已有的 dsh 会话搬到飞书：手机收发消息、伪流式 round 卡、审批/选择/问询交互卡、
> `/btw` 侧问、后台完成推送。只出站 WebSocket（长连接），不开端口、不要内网穿透；
> 飞书（feishu.cn）与 Lark（国际版）双域支持。

## 配置入口（不是 settings.yaml）

功能配置只认 **`~/.dsh/cordis.patch.yml` 挂载块的 `config:` 段**（未知键会直接报错、
插件停用，宁报错不静默）：

```yaml
# ~/.dsh/cordis.patch.yml
- id: dsh-feishu
  config:
    operators:
      - ou_xxxxxxxxxxxxxx     # 你的 open_id（飞书管理后台 → 成员详情页）
    # domain: feishu          # feishu（国内）| lark（国际版）
    # backgroundPush: cron     # off | cron | all
```

**`~/.dsh/settings.yaml` 的 `dsh-feishu:` 段不是配置**——那是 StateStore 运行态
（绑定的会话 id、手机端模型/思考档位偏好、picker 状态）。想重置手机配对就删掉这一段，
不要往这里写功能配置。

### 凭据三种途径

推荐把凭据存进 dsh credentials 服务（refs 默认名即 `dsh-feishu-app-id` /
`dsh-feishu-app-secret`，无需额外配置）：

```yaml
# ~/.dsh/.credentials.yaml （chmod 600；改完重启 dsh 生效）
dsh-feishu-app-id: cli_xxxxxxxxxx
dsh-feishu-app-secret: xxxxxxxxxxxxxxxx
```

运行时解析优先级：**patch config 明文 `appId`/`appSecret` > `DSH_FEISHU_APP_ID` /
`DSH_FEISHU_APP_SECRET` env > credentials refs**（逐键兜底：哪个键缺就走哪个键的 refs）。
明文写进 patch config 仅作本地测试的逃生口，正式配置用 refs 或 env。

## config 全键表

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `mode` | `"on"` | `"off"` 完全停用插件 |
| `domain` | `"feishu"` | `"feishu"`（国内）或 `"lark"`（国际版） |
| `operators` | `[]` | open_id 白名单，**必填才激活**；空列表 = bot 完全休眠（不连接、不回复） |
| `appId` | `""` | 明文 App ID（逃生口，优先用 refs/env） |
| `appSecret` | `""` | 明文 App Secret（逃生口，仅限本地测试） |
| `appIdRef` | `"dsh-feishu-app-id"` | credentials 服务里 App ID 的 ref 名 |
| `appSecretRef` | `"dsh-feishu-app-secret"` | credentials 服务里 App Secret 的 ref 名 |
| `statusIntervalMs` | `5000` | round 卡刷新节拍（伪流式）；超出 [5000, 600000] 报错停用 |
| `bodySegmentChars` | `3500` | 长正文分段阈值；超出 [500, 30000] 报错停用 |
| `resumeListStyle` | `"auto"` | `/resume` 列表渲染：`auto`（表格卡，失败回退 markdown 列表）/ `table` / `list` |
| `btwContextMessages` | `6` | `/btw` 侧问携带的最近对话条数，[0, 50]；0 = 不带快照 |
| `backgroundPush` | `"off"` | 手机未绑定会话的完成推送（发到最后活跃聊天）：`off` / `cron`（带 cron 投递或子代理结算的回合）/ `all`（所有回合） |

### 环境变量（`DSH_FEISHU_*`）

| 变量 | 作用 |
| --- | --- |
| `DSH_FEISHU_OPERATORS` | 逗号分隔 open_id，**追加**到 config 白名单（本地快速测试免改 patch） |
| `DSH_FEISHU_APP_ID` | App ID（patch 未给明文 `appId` 时生效） |
| `DSH_FEISHU_APP_SECRET` | App Secret（patch 未给明文 `appSecret` 时生效） |
| `DSH_FEISHU_BACKGROUND_PUSH` | `cron` / `all`，其它值视为 `off`；patch config 显式配置优先于 env |

注意：代码注释里出现过 `DSH_FEISHU_BTW_CONTEXT_MESSAGES`，但当前版本运行时**不读取**
它——`/btw` 快照大小只认 config 键 `btwContextMessages`。

## 交互式配置向导（ask_user_question）

用户说"帮我配飞书机器人 / 配置 feishu"时，不要甩文档让对方自己读——按下面流程走：

1. **前置核查**：
   - 飞书开放平台应用是否已建好（企业自建应用）：事件订阅用**长连接**，订阅
     `im.message.receive_v1`（收消息）与 `card.action.trigger`（卡片交互——问询卡和
     /resume 选择卡必需）；权限开 `im:message:send_as_bot`、`im:message.p2p_msg:readonly`、
     群聊加 `im:message.group_msg:readonly`、图片加 `im:message.resources:readonly`、
     `im:message.reactions:write`；可用范围加自己后**创建版本并发布**（不发布事件不通，
     最常见卡点）。
   - appId/secret 是否已存：查 `~/.dsh/.credentials.yaml` 与 env。**不要让用户把
     secret 贴进对话**（会进 session 日志）；没有就引导用户自己写进 credentials 文件。
2. **operators open_id 列表**：管理后台成员详情页可查；白名单外的人私聊 bot
   完全隐身。列表为空 = bot 完全休眠。
3. **backgroundPush 三档**：`off`（默认，bot 不主动打扰）/ `cron`（cron 投递与
   子代理结算）/ `all`（每个回合结束）。
4. **细调（可选）**：`domain`（用户在海外用 Lark 才改）、`statusIntervalMs`、
   `bodySegmentChars`、`btwContextMessages`。

收集完**代写/修补** `~/.dsh/cordis.patch.yml` 挂载块的 `config:` 段，然后提示：

- 重启 dsh 生效；启动日志出现 `dsh-feishu: armed (N operator(s), feishu)` 即成功。
- 手机端首次配对：飞书私聊 bot 发 `/help` 看命令清单 → `/resume` 从列表选会话绑定
  → 之后发文本即派活（turn 进行中发消息自动 steer 并入当前回合）。
- 推荐加装 [@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router)
  （多端问询：手机卡与桌面 TUI 双端同弹、先答先得）——加进 bundles，放在 dsh-base
  之后、UI bundle 之前；web profile 勿装。

## 手机命令速查

| 命令 | 作用 |
| --- | --- |
| `/resume` | 交互式会话选择卡（下拉+进入；或回复 `/resume N`） |
| `/new` | 开新会话并绑定（继承工作目录、模型、推理档位） |
| `/stop` | 中止当前 turn（排队消息保留） |
| `/btw <问题>` | 主线运行中的旁路快问，独立卡片流式作答，主线无感；空参重发上一条 |
| `/status` | 绑定与运行状态 |
| `/model` | 交互式模型选择（bot 建的会话实时切换，否则存为手机默认） |
| `/think` | 交互式思考档位选择 |
| `/permission` | 交互式权限 preset 选择 |
| `/select-skill` | 交互式技能激活选择（桌面 `/skills` 的手机替代） |
| `/profile-switch` | 交互式模型 profile 切换 |

桌面系命令（`/settings` `/preset` `/theme` `/reload` `/hotkeys` `/model-sync` `/export`
`/agents` `/subagents` `/profile-cfg` `/login` `/logout` `/skills`，以及 `/goal` `/dcp`）
由桌面 dsh-tui-pi 插件提供或暂未适配——手机端会拒绝并指路去电脑端（`/skills` 会提示
用 `/select-skill` 替代）。

## 排障

1. **收不到消息**：先查 operators 白名单（非白名单静默忽略，不回任何东西）；再查
   事件订阅（长连接 + `im.message.receive_v1`）与应用版本是否已发布。
2. **凭据 40x / 日志 `no Lark credentials`**：按优先级核对 patch 明文 > env > refs；
   credentials 文件改完要重启 dsh。
3. **`/resume N` 报过期**：会话列表 5 分钟有效，重发 `/resume`。
4. **SIGKILL 后 `/tmp/dsh-feishu-bot.lock` 残留**：下次启动的 stale-pid 检查自动接管，
   无需手工删除；另一个活着的 dsh 进程持锁时，本实例保持休眠（单实例设计）。
