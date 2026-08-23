# dsh-feishu — 用飞书驾驶 dsh

> dsh（DeepSeek Harness）伴生插件：一个只出站的飞书机器人，把**已存在的** dsh 会话
> 接到手机上——派活、看进度、收回复。独立包独立 `cordis.patch.yml`，与 dsh-tui-pi
> 同 profile 共存互不干扰，也可以在没有 TUI 的 profile 里单独安装。
>
> 设计定案见 `~/github/docs/dsh-feishu-bot-design-research.md`（2026-08-23）。
> 本仓库为 **private**，不发布 npm。

## 能力（v0.1）

- **接入已有会话**：`/resume` 列出最近 10 个可恢复的根会话（目录 · 最后时间 · 首条
  消息预览），回复 `/resume N` 进入。**从不创建新会话**——插件代码里没有
  `agents.create` 调用，机制上杜绝「双 main」。
- **手机派活**：直接发文本即 `agent.followup` 注入；turn 进行中到达的消息排队到
  下一轮（inbox 语义）。远端消息会正常出现在 TUI 转录里。
- **运行状态卡**：每轮 turn 一张卡，原位更新（30s 节拍 + 内容变化检测，不做流式
  卡片），`turn/end` 定稿（✅/❌/⛔ + 总耗时 + todo 进度）后把 assistant 正文按
  段发成普通消息。think/tool 尾行默认关闭，`/display think on` 开启。
- **子代理行**：主卡内紧凑行 `├ workhorse ↻ · round 2 · tail…`；`/sub N` 看近况。
- **命令**：`/status /help /stop /new /resume /sub /display` 为 bot 自有；
  `/goal /dcp /export /agents /subagents` 透传 host；`/settings /preset /theme` 等
  配置类回复「请在电脑端操作」。`/model /think /skills`（选择器语义）暂同样引导
  到电脑端，后续可加文本列表流。
- **附着语义**：目标会话已 live（TUI 正在跑）→ `agents.get()` 附着同一引用，注入
  直达；未 live → `agents.resume` 恢复（bot 持有并管理该 handle）。绝不 resume 一个
  已 live 的会话。

## 安装（本机 link 方式）

```bash
cd ~/github/dsh-feishu
npm install          # 装 @larksuiteoapi/node-sdk
npm run link-closure # 把 @deepseek-ai/* 软链到全局 dsh 闭包（类型+运行时解析）
dsh plugin add ~/github/dsh-feishu
```

`dsh plugin add` 会读取包内 `cordis.patch.yml` 自动挂载（含 `dsh.bundle.patch`
声明）。卸载：`dsh plugin remove dsh-feishu`。

> `@deepseek-ai/*` 一律**不声明**在 package.json 里——由 link-closure 软链到全局
> dsh 闭包解析，保证进程内只有一个 cordis 实例（workspace 铁律 8）。

## 配置

### 1. 飞书应用（自建应用 + 机器人能力）

- 开启**机器人**能力，添加**接收消息** `im.message.receive_v1` 事件订阅，
  订阅方式选**长连接**（免公网）。
- 拿到 `App ID` / `App Secret`。
- 私聊可用：把机器人拉进你的可用范围，和它单聊。

### 2. 凭证（二选一）

- **dsh credentials 服务**（推荐）：
  ```bash
  dsh credentials set dsh-feishu-app-id    cli_xxxx
  dsh credentials set dsh-feishu-app-secret xxxx
  ```
  （refs 可通过 `appIdRef` / `appSecretRef` 配置项改名；不进 repo、不进 settings.yaml。）
- **环境变量**（本地测试方便）：`DSH_FEISHU_APP_ID` / `DSH_FEISHU_APP_SECRET`。

### 3. 操作者白名单（必填）

编辑挂载处的 config（profile 的 bundle 配置或 `~/.dsh/cordis.patch.yml`）：

```yaml
- id: dsh-feishu
  name: '@aiwayds/dsh-feishu'
  config:
    operators:
      - ou_xxxxxxxxxxxxxx   # 你的 open_id（飞书管理后台/调试台可见）
```

也可用环境变量 `DSH_FEISHU_OPERATORS=ou_a,ou_b` 追加。**白名单为空时插件装死**
（不连飞书、不回复任何人）。非白名单消息**静默忽略**。

### 全部配置项

| key | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `on` | `off` 完全停用 |
| `domain` | `feishu` | `feishu` 或 `lark`（国际版） |
| `operators` | `[]` | 操作者 open_id 白名单（必填才激活） |
| `appId` / `appSecret` | — | 明文凭证逃生门（仅本地测试；优先走 credentials/env） |
| `appIdRef` / `appSecretRef` | `dsh-feishu-app-id` / `dsh-feishu-app-secret` | credentials refs |
| `statusIntervalMs` | `30000` | 状态卡节拍（5000–600000） |
| `bodySegmentChars` | `3500` | 长正文分段阈值（500–30000） |

运行时可变状态（当前绑定、think 显示开关、最近聊天）持久化在 dsh settings 的
`dsh-feishu` namespace；无 settings 服务时退化为内存（重启后需重新 `/resume`）。

## 安全模型

- **全程只出站**：WSClient 出站长连接，不开任何入站端口，符合 dsh trust-fence 姿势。
- **身份即认证**：每条消息校验 sender `open_id` 白名单；群聊消息忽略（v1 仅私聊）。
- **单实例锁**：`$TMPDIR/dsh-feishu-bot.lock`（pid 存活探测，僵尸锁自动抢占）。
  飞书长连接集群模式不广播，多实例会随机分摊事件——锁保证本机一个 bot。
- **凭证纪律**：secret 走 credentials 服务或环境变量；repo 里只有 ref 名。
- **不代建**：绝不 `agents.create`；对已 live 会话只 attach 不重复 resume。

## 已知边界（v0.1）

- 卡片按钮回调（`card.action.trigger`）未订阅——v1 全部交互走文本命令，无按钮。
- `/model /think /skills` 手机端暂不可用（选择器语义，待做文本列表流）。
- resume 附着后**不回放历史**：只发切换确认；状态从附着时刻起算。
- turn 进行中附着（mid-turn attach）时，本轮计数从附着时刻起，不含已发生的步骤。
- bot 与 TUI 各自 resume 同一个会话属未定义行为（registry 碰撞边界），单操作者
  纪律下不会出现；`/resume N` 对 live 会话总是走 attach 规避。
- 飞书消息卡片 `PATCH` 更新有频控；30s 节拍（2 次/分）距限频上限三个数量级。

## 开发

```bash
npm run check   # tsc --noEmit（precheck 自动补链 dsh 闭包）
npm test        # 构建 + node --test（纯逻辑单测）
```

结构：`src/lark-client.ts`（WS+REST 封装，唯一外联）· `src/bot.ts`（编排：入站
队列/命令/卡片生命周期）· `src/binder.ts`（attach/resume，永不 create）·
`src/run-state.ts` + `src/card.ts`（纯函数状态机与卡片投影）· `src/resume-table.ts`
（/resume 表格流）· `src/commands.ts`（命令路由）· `src/state-store.ts`（settings
namespace 持久化）· `src/index.ts`（入口/单实例锁/凭证）。

## 路线图（按设计文档渐进档位）

F1 完成/失败通知 ✅（状态卡定稿 + reaction）→ F4 派活 ✅ → F2 进度直播 ✅（状态卡）。
未做：F3 审批到手机（`ctx.approval` 文本版）、F5 流式对话（CardKit，明确不做）。
