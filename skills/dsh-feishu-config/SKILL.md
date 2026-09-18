---
name: dsh-feishu-config
description: "dsh 飞书机器人插件（@aiwayds/dsh-feishu）使用与配置指南。凡涉及飞书/Lark 接入、机器人申请/创建、手机端控制 dsh、卡片交互、后台推送，或要配置 feishu 时先读本指南：首次配置优先引导桌面 TUI 运行 /feishu-onboard（扫码一键创建应用并自动写入凭据与 operators）；手动路径见指南：cordis.patch.yml 挂载块 config: 段 12 键（mode/domain/operators/appId/appSecret/凭据 refs/statusIntervalMs/bodySegmentChars/resumeListStyle/btwContextMessages/backgroundPush）、DSH_FEISHU_* 环境变量、ask_user_question 配置向导、operators 空=配对模式（首个私聊者点卡成为管理员）、settings.yaml dsh-feishu: 段是运行态非配置。触发词：飞书、feishu、lark、机器人、operators、配对、绑定、backgroundPush。"
---

# dsh-feishu 使用指南（飞书 / Lark 手机端驾驶 dsh）

> 把已有的 dsh 会话搬到飞书：手机收发消息、伪流式 round 卡、审批/选择/问询交互卡、
> `/btw` 侧问、后台完成推送。只出站 WebSocket（长连接），不开端口、不要内网穿透；
> 飞书（feishu.cn）与 Lark（国际版）双域支持。首次配置优先走桌面命令
> `/feishu-onboard`（扫码一键创建应用并自动写入凭据与管理员）。

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
（绑定的会话 id、手机端模型/思考档位偏好、picker 状态，以及配对产生的
`pairedOperators` 管理员名单）。想重置手机配对就删掉这一段，不要往这里写功能配置。

### 凭据三种途径

推荐把凭据存进 dsh credentials 服务（refs 默认名即 `dsh-feishu-app-id` /
`dsh-feishu-app-secret`，无需额外配置）；`/feishu-onboard` 扫码路径会自动写入，
手工路径见下：

```yaml
# ~/.dsh/.credentials.yaml （chmod 600；改完重启 dsh 生效）
dsh-feishu-app-id: cli_xxxxxxxxxx
dsh-feishu-app-secret: xxxxxxxxxxxxxxxx
```

运行时解析优先级：**patch config 明文 `appId`/`appSecret` > `DSH_FEISHU_APP_ID` /
`DSH_FEISHU_APP_SECRET` env > credentials refs**（逐键兜底：哪个键缺就走哪个键的 refs）。
明文写进 patch config 仅作本地测试的逃生口，正式配置用 refs 或 env。
注意：检测到 `DSH_FEISHU_APP_ID`/`DSH_FEISHU_APP_SECRET` 环境变量时，其优先级**高于凭据文件**。

## 首次配置：三条路径

按优先级：**桌面 `/feishu-onboard` 一键引导 > 手动 6 步（用户自己上控制台）>
agent 向导兜底细调**。agent 替用户干活时，能跑命令就优先引导路径一。

### 路径一（推荐）：桌面 TUI 运行 /feishu-onboard

让用户在**电脑端 dsh 的 TUI** 输入 `/feishu-onboard`。命令调宿主 ask 逐问引导，
按用户现状三选一：

1. **没有应用 → 扫码一键创建**：走飞书官方 SDK registerApp（OAuth 设备码流程），
   终端渲染二维码，用户用飞书 App 扫码确认后自动创建**企业自建应用**，预置：
   - 机器人能力；
   - WebSocket 长连接事件订阅 `im.message.receive_v1` + 卡片回调 `card.action.trigger`；
   - 六项权限：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、
     `im:message.group_at_msg:readonly`、`im:message.resources:readonly`、
     `im:message.reactions:write`、`im:chat:readonly`。

   创建后返回 app_id/app_secret 与扫码用户 open_id：插件自动把凭据写进
   credentials 服务（refs 默认 `dsh-feishu-app-id`/`dsh-feishu-app-secret`）、把扫码
   用户写进管理员名单，然后**同进程直接热激活，无需重启 dsh**。
2. **已有应用**：用户提供 App ID / App Secret（只写本地凭据文件，不进会话日志）→
   插件调 API 验证（tenant_access_token + `bot/v3/info`）：
   - 凭据错 → 要求重输；
   - 错误码 **11205**（没开机器人能力）→ 凭据仍保存，并给出修复清单；
   - 验证通过后可选填 open_id 加入管理员名单。
3. **只要手动指南**：命令直接输出下面路径二的 6 步操作指南。

问询走 dsh 宿主原生 ask（`ctx.userQuestions`，锚定命令所在会话的 live root
agent）：**web 端问询卡直接弹在浏览器里**（agent-scoped waterfall 是 web 桥接
唯一转发的形态，无 agent 的 ask 在 web 端必死 NO_PROVIDER）；TUI 弹桌面面板；
无 ask 提供方（如 headless）或没有活跃会话时，命令自动降级为纯指南输出。

注意事项：

- addons 预置在平台灰度未覆盖时可能被忽略——创建后命令会自动验证并给权限预选
  深链补救；
- 要让**其他同事**也用这个机器人：需到开放平台「版本管理与发布」创建版本并发布
  （只自己用则不用）；
- 环境变量优先级高于凭据文件（见上），验证前先清理已有的
  `DSH_FEISHU_APP_ID`/`DSH_FEISHU_APP_SECRET`。

### 路径二：手动申请指南（6 步，用户自己上 open.feishu.cn 控制台）

agent 按步指导用户在控制台操作：

1. 创建**企业自建应用**，记下 App ID（`cli_` 开头）与 App Secret；
2. 「应用能力」添加**机器人**；
3. 「权限管理」开通六项权限（同路径一清单）——可访问
   `https://open.feishu.cn/app/{AppID}/auth?q=<逗号分隔scope>&op_from=openapi`
   预选一键开通；
4. 「事件与回调」订阅方式选**使用长连接接收事件**，添加事件
   `im.message.receive_v1` 与回调 `card.action.trigger`；
5. 「版本管理与发布」创建版本（可用范围先加自己）并申请发布——**不发布事件不通，
   最常见卡点**；
6. 凭据写入 `~/.dsh/.credentials.yaml`（chmod 600）后重启 dsh；operators 可用
   cordis.patch.yml 的 `config.operators` 或 `DSH_FEISHU_OPERATORS` env
   （逗号分隔）提供。

### 路径三：agent 向导兜底

`/feishu-onboard` 完成后或用户偏好对话式配置时，用下方「交互式配置向导」做细调
（backgroundPush、statusIntervalMs 等）。

## 配对模式（operators 为空时的激活态）

凭据已配但 operators（`config.operators` ∪ settings.yaml `dsh-feishu.pairedOperators`）
为空时，bot 不再完全休眠——会连接并以**配对模式**运行：

- 任何人**私聊** bot 会收到「管理员配对」确认卡，点按钮即成为管理员；
- **先到先得**：第一个点卡的人拿走管理员名额，写入 settings.yaml
  `dsh-feishu.pairedOperators`，立即生效、无需重启；
- 群聊永不触发配对；已配满后，非名单成员依旧完全隐身。

安全提示：配对窗口期内任何给 bot 发私聊的人都可能**抢先**成为管理员（先到先得）——
请在可信环境完成配对，配好后核对 `pairedOperators` 是否符合预期；要重新配对就删掉
settings.yaml 的 `dsh-feishu:` 段。

## config 全键表

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `mode` | `"on"` | `"off"` 完全停用插件 |
| `domain` | `"feishu"` | `"feishu"`（国内）或 `"lark"`（国际版） |
| `operators` | `[]` | open_id 白名单；空 + 凭据已配 = 配对模式（见上节），无凭据则保持休眠 |
| `appId` | `""` | 明文 App ID（逃生口，优先用 refs/env） |
| `appSecret` | `""` | 明文 App Secret（逃生口，仅限本地测试） |
| `appIdRef` | `"dsh-feishu-app-id"` | credentials 服务里 App ID 的 ref 名 |
| `appSecretRef` | `"dsh-feishu-app-secret"` | credentials 服务里 App Secret 的 ref 名 |
| `statusIntervalMs` | `5000` | round 卡刷新节拍（伪流式）；超出 [5000, 600000] 报错停用 |
| `bodySegmentChars` | `3500` | 长正文分段阈值，兼作嵌入上限——落定轮次的正文不超过它就直接嵌进该轮 Round 卡（`💬 Round 回复` 段），不再单独发消息；超出 [500, 30000] 报错停用 |
| `resumeListStyle` | `"auto"` | `/resume` 列表渲染：`auto`（表格卡，失败回退 markdown 列表）/ `table` / `list` |
| `btwContextMessages` | `6` | `/btw` 侧问携带的最近对话条数，[0, 50]；0 = 不带快照 |
| `backgroundPush` | `"off"` | 手机未绑定会话的完成推送（发到最后活跃聊天）：`off` / `cron`（带 cron 投递或子代理结算的回合）/ `all`（所有回合） |

### 环境变量（`DSH_FEISHU_*`）

| 变量 | 作用 |
| --- | --- |
| `DSH_FEISHU_OPERATORS` | 逗号分隔 open_id，**追加**进 config 白名单（本地快速测试免改 patch） |
| `DSH_FEISHU_APP_ID` | App ID（patch 未给明文 `appId` 时生效；优先级高于凭据文件） |
| `DSH_FEISHU_APP_SECRET` | App Secret（patch 未给明文 `appSecret` 时生效；优先级高于凭据文件） |
| `DSH_FEISHU_BACKGROUND_PUSH` | `cron` / `all`，其它值视为 `off`；patch config 显式配置优先于 env |

注意：代码注释里出现过 `DSH_FEISHU_BTW_CONTEXT_MESSAGES`，但当前版本运行时**不读取**
它——`/btw` 快照大小只认 config 键 `btwContextMessages`。

## 交互式配置向导（ask_user_question）

用户说"帮我配飞书机器人 / 配置 feishu"时，先记住：**能跑命令的场景，优先让用户在
桌面 TUI 直接运行 `/feishu-onboard`**（自动写凭据+白名单+热激活），agent 再走向导做
细调（backgroundPush/statusIntervalMs 等）：

1. **前置核查**：应用侧准备按上方「路径二：手动申请指南」的 6 步核对（能力/权限/
   事件订阅/版本发布），此处不重复展开。另查 appId/secret 是否已存：
   `~/.dsh/.credentials.yaml` 与 env。**不要让用户把 secret 贴进对话**（会进
   session 日志）；没有就引导用户自己写进 credentials 文件。
2. **operators open_id 列表**：管理后台成员详情页可查；白名单外的人私聊 bot
   完全隐身。列表为空 + 凭据已配 = 配对模式（见上节）。
3. **backgroundPush 三档**：`off`（默认，bot 不主动打扰）/ `cron`（cron 投递与
   子代理结算）/ `all`（每个回合结束）。
4. **细调（可选）**：`domain`（用户在海外用 Lark 才改）、`statusIntervalMs`、
   `bodySegmentChars`、`btwContextMessages`。

收集完**代写/修补** `~/.dsh/cordis.patch.yml` 挂载块的 `config:` 段，然后提示：

- 重启 dsh 生效（`/feishu-onboard` 路径热激活、无需重启）；启动日志出现
  `dsh-feishu: armed (N operator(s), feishu)` 即成功。
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
5. **激活后其他人用不了机器人**：应用未创建版本发布，或对方不在可用范围内。
