# dsh-feishu — 用飞书驾驶 dsh

> [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）伴生插件：
> 一个**只出站**的飞书机器人，把**已存在的** dsh 会话接到手机上——派活、看进度、收回复。
>
> - 独立包、独立 `cordis.patch.yml`，与 dsh-tui-pi 同 profile 共存互不干扰，也可单独安装
> - **从不创建新会话**：代码里没有 `agents.create` 调用，机制上杜绝「双 main」
> - 全程只出站 WebSocket，不开公网端口、不需要隧道/内网穿透
>
> 本仓库为 private，不发布 npm。设计定案见
> `~/github/docs/dsh-feishu-bot-design-research.md`。

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始（5 步）](#快速开始5-步)
- [第一步：创建飞书应用（网页操作）](#第一步创建飞书应用网页操作)
- [第二步：安装插件到 profile](#第二步安装插件到-profile)
- [第三步：配置凭证](#第三步配置凭证)
- [第四步：配置操作者白名单](#第四步配置操作者白名单)
- [第五步：启动并验证](#第五步启动并验证)
- [日常使用](#日常使用)
- [配置参考](#配置参考)
- [安全模型](#安全模型)
- [工作原理](#工作原理)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [已知边界与路线图](#已知边界与路线图)

---

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 接入已有会话 | `/resume` 以飞书原生表格列出最近更新的 10 个可恢复根会话（`#` · 会话（预览·目录）· 最后更新时间；排序口径与 TUI 一致——jsonl 日志 mtime，缺失时回退 createdAt），`/resume N` 进入；默认 `auto` 渲染——表格卡**发送失败**（服务端拒收/限流重试耗尽/传输错误）自动降级重发一次 markdown 有序列表，`table`/`list` 可强制指定。注意：老客户端「收到了但静默渲染不出表格」发生在投递之后、发送侧检测不到，那种场景请配 `resumeListStyle: "list"` |
| 手机派活 | 直接发文本即注入会话：turn **运行中默认 steer**（dsh inbox `next-step`，并入当前 turn 的下一个 round——中途纠偏即时生效）；空闲时 followup 开新 turn。消息同步出现在 TUI 转录里 |
| Round 卡 | **每个 round（一次 LLM 往返）一张卡**：round 开始即推送（header `Round N` + 当前状态：🤔 thinking / 🔧 工具名 / ⚙️ processing / ⏳ subagent ×k），**5s 节拍**原位更新（伪流式：生成中的正文以 ✍️ 尾行随节拍生长）；round 落地定稿为 `Round N · 💬 回复 · 时长` 并**紧随原文正文卡**；turn 结束把在飞卡定稿为 `Round N · ✅/❌/⛔ · 总耗时`。正文为 markdown 章节——**活动**（thinking 状态、工具调用、本轮 LLM 消息行）、**子代理**（状态 + 最新输出行）、**Todo**（首行 `☑ x/z`，条目 `- [x]`/`- [ ]`），页脚统计 `⏱ 耗时 · 🤖 模型 · 🧠 档位 · 📊 ctx% · ⚡ CH%（网关上报才显示） · 🔧 calls`（路由/缓存基线绑定时从会话日志回填） |
| 收完整回复 | 每个 round 落地时其 assistant 正文即原文分段送达（代码块/表格原生渲染）；turn 结束尾卡定稿 |
| 子代理可见 | 独立**子代理**章节逐个列出：`workhorse·49a6 · ⏳ round 2 · 🔧 bash · 最新输出行`（收尾显示 ✔/✘/⛔）；`/sub N` 看单个子代理近况 |
| 远程急停 | `/stop` 中止当前 turn（排队消息保留）；`/new` 开新会话 |
| 手机问询 | dsh 的 ask_user_question 在手机上弹**交互卡**（下拉/多选/文本输入 + 提交），提交即答复。**建议安装 `@aiwayds/dsh-ask-router`**（不强制，见「问询交互」节）：装了与 TUI 面板双端同弹、先答先得；不装时视部署形态而定，可能完全没有手机端交互 |

## 快速开始（5 步）

```
① 飞书开放平台建自建应用（开机器人 + 长连接事件订阅）   ≈10 分钟
② 插件装进 dsh profile                                 ≈2 分钟
③ 凭证写入 ~/.dsh/.credentials.yaml                    ≈1 分钟
④ 你的 open_id 写进 operators 白名单                   ≈1 分钟
⑤ 重启 dsh，私聊 bot 发 /help                          即刻验证
```

没配完白名单/凭证时插件是**装死态**（连接不上飞书、不回复任何人）——这是故意的安全默认，
不是故障。启动日志会有对应的 dormant 警告行，见[故障排查](#故障排查)。

## 第一步：创建飞书应用（网页操作）

登录 [open.feishu.cn](https://open.feishu.cn)（飞书管理员的开发者账号），创建「**企业自建应用**」：

1. **记下凭证**：应用详情页的 `App ID`（`cli_` 开头）和 `App Secret`。
2. **开启机器人**：「添加应用能力」→ 选择**机器人**。不开的话这个应用不会出现在会话里。
3. **订阅事件**：「事件与回调」→ 事件订阅 → 添加 `im.message.receive_v1`（接收消息）。
   ⚠️ 订阅方式必须选「**使用长连接接收事件**」。本插件只做出站 WebSocket 连接；
   webhook 模式需要公网 URL 和加解密策略，不要选。
4. **开通权限**：「权限管理」中按需开通（首次发版时按提示确认即可）：
   - `im:message:send_as_bot` —— 以机器人身份发消息
   - `im:message.p2p_msg:readonly` —— 读取私聊消息（事件所需）
   - `im:message.reactions:write` —— 表情回应（👀 已收到 / 👍 完成）
5. **可用范围**：「可用范围」里把你自己（及允许使用的同事）加进去。不在范围内的人
   无法和 bot 私聊。
6. **发布版本**：「版本管理与发布」→ 创建版本 → 发布。企业自建应用一般管理员直接通过。
   ⚠️ **不发布事件不通**——这是最常见的配对卡点。

## 第二步：安装插件到 profile

### 全新机器从零装

```bash
git clone git@github.com:fan56/dsh-feishu.git ~/github/dsh-feishu   # private repo
cd ~/github/dsh-feishu
npm install            # 安装唯一真实依赖 @larksuiteoapi/node-sdk
npm run link-closure   # 把 @deepseek-ai/* 软链到全局 dsh 闭包（无全局 dsh 时跳过）
npm test               # 可选：跑 156 个单测确认环境正常
```

然后接入 profile（以 `tui` 为例）。编辑 `~/.dsh/profiles/tui/package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …现有 bundles…
        "@aiwayds/dsh-feishu"          // ← 新增这行
      ]
    }
  },
  "dependencies": {
    // …现有依赖…
    "@aiwayds/dsh-feishu": "link:/Users/<你>/github/dsh-feishu"   // ← 新增这行
  }
}
```

```bash
cd ~/.dsh/profiles/tui && pnpm install
```

> 用 `link:` 指向仓库目录 = 实时生效：在仓库里改代码重新 `npm run build`，
> profile 端无需重装。（改前建议按惯例备份 package.json / pnpm-lock.yaml。）

### 验证挂载

```bash
dsh --profile tui --dump-config | grep -A 3 feishu
```

看到 `- id: dsh-feishu` 即 bundle patch 生效（本插件自带 `cordis.patch.yml`，
`dsh.bundle.patch` 声明齐全，无需手写 patch 条目）。

> **为什么 `@deepseek-ai/*` 不在 dependencies 里**：dsh 的契约是全部 `@deepseek-ai/*`
> 解析到同一个全局闭包。声明成普通依赖会被包管理器装出第二份 cordis 实例，导致跨
> realm 的诡异崩溃。本仓库由 `link-closure` 软链解析，与 dsh-tui-pi 同一姿势
> （详见工作区 AGENTS.md 铁律 8）。

## 第三步：配置凭证

插件的解析优先级（启动时解析一次，**改动后需重启 dsh**）：

1. patch 配置里的明文 `appId` + `appSecret`（仅本地测试逃生门）
2. 环境变量 `DSH_FEISHU_APP_ID` + `DSH_FEISHU_APP_SECRET`
3. dsh credentials 服务，refs 默认 `dsh-feishu-app-id` / `dsh-feishu-app-secret`

**推荐走 credentials 文件**——secret 不落 settings.yaml、不进 repo：

```yaml
# ~/.dsh/.credentials.yaml （权限应为 600，文件被 dsh 监听热更新）
dsh-feishu-app-id: cli_xxxxxxxxxx
dsh-feishu-app-secret: xxxxxxxxxxxxxxxx
```

refs 名可通过 `appIdRef` / `appSecretRef` 配置项改名。

三源都读不到时插件保持 dormant，日志输出
`no Lark credentials (tried config/env, then refs …) — plugin dormant`。

## 第四步：配置操作者白名单

bot 只响应白名单内的飞书用户（按 sender `open_id` 校验）；**白名单为空 = 插件完全不激活**。

拿到你自己的 open_id：

- 飞书管理后台 → 成员与部门 → 成员详情页查看；或
- 开发者后台调试台查当前用户；或命令行
  `lark-cli contact +search-user --query "你的名字"`（返回中的 open_id 字段）。

写入 home 层 patch（`~/.dsh/cordis.patch.yml`，对 profile 内所有挂载生效）：

```yaml
- id: dsh-feishu
  config:
    operators:
      - ou_xxxxxxxxxxxxxx     # 你自己的 open_id
      # - ou_yyyy…           # 可以放多个操作者
```

也可以用环境变量追加：`DSH_FEISHU_OPERATORS=ou_a,ou_b`。

非白名单用户的私聊消息会被**静默忽略**——不回复、不回应、不留痕，bot 的存在感为零。

## 第五步：启动并验证

```bash
dsh --profile tui
```

启动日志出现：

```
dsh-feishu: armed (1 operator(s), feishu)
```

即全部配对成功。然后在飞书里**私聊这个 bot**：

1. 发 `/help` → 回命令清单（证明收发双向通、白名单生效）
2. 发 `/resume` → 回一张卡片，会话列表以飞书原生表格呈现（3 列：`#` / 会话 / 时间）。
   默认 `auto`：表格卡发送失败会自动降级为 markdown 有序列表重发一次；
   若你的客户端版本老到「收到了但表格渲染空白」（投递后行为，发送侧检测不到），配 `resumeListStyle: "list"` 强制列表
3. 回复 `/resume N` → 「已进入会话：…」（若该会话正在 TUI 里跑，是附着同一实例，
   TUI 转录会出现你的手机消息气泡）
4. 发一段任务文本 → 收到 👀 reaction；TUI 开始干活，飞书收到状态卡
5. turn 结束 → 状态卡定稿 ✅ + assistant 正文分段送达

## 日常使用

### 命令总表

| 命令 | 说明 |
| --- | --- |
| `/resume` | 列出最近更新的 10 个可恢复根会话（按最后更新时间排序，与 TUI 一致；**自动剔除无对话内容的 scratch 会话**——TUI 每次启动的 resume 命令残留不再霸占顶部；选择列表 5 分钟有效且**跨 dsh 重启持久化**；进入失败时回复携带具体原因） |
| `/resume N` | 进入列表第 N 个会话；live 会话直接附着，冷会话从持久化恢复 |
| `/new` | 结束当前绑定并**创建接入一个全新会话**：旧流最后一张卡灰化定稿 + 🆕 绿色边界卡分隔（聊天历史不删除）；新会话继承旧会话 cwd；`/resume` 可回旧会话；创建失败回复具体原因 |
| `/stop` | 停止当前正在运行的 turn（排队中的消息保留，下一轮继续处理） |
| `/status` | 绑定与运行快照：绑定态 / rounds / tools ✔✘ / 子代理数 / think 显示开关 |
| `/sub N` | 查看第 N 个子代理近况（round 数、最近工具、最新输出 tail） |
| `/feishu-plugin think on\|off` | 开关活动章节里的思考尾行显示（**默认 on**，持久化保存；命令以插件名命名，手机侧命令归属一目了然） |
| `/help` | 命令清单（随绑定态变化提示语） |
| `/goal` `/dcp` `/export` `/agents` `/subagents` | 透传给 dsh host 命令注册表执行 |
| 其他任何文本 | 作为 prompt 注入当前绑定的会话 |
| `/settings` `/preset` `/theme` `/reload` `/hotkeys` `/model-sync` `/session` | 配置类命令回复「请在电脑端操作」（`/session` 例外：镜像为 `/status`） |
| `/model` `/think` `/skills` | 暂同上（选择器语义，待做手机端文本列表流） |

### 典型流程

```
出门前电脑上有会话跑到一半
  → 地铁上打开飞书私聊 bot：/resume
  → 回 /resume 3 进入那个会话
  → 「继续把 e2e 修完，重点看 timeout 那两个 case」
  → 收到 👀；round 卡实时刷新（Round N · 🔧 bash / 🧵 ×1 workhorse…）
  → 每 round 落地：卡定稿 💬 + 该轮正文；turn/end：尾卡 ✅ 定稿
  → 中途想叫停：/stop
```

### 与 TUI 的协同语义

- bot 附着的是**同一个 agent 实例**：手机派的消息会出现在 TUI 转录里，TUI 侧照常
  可以继续对话、`/model`、看面板——两边是同一会话的两个遥控器。
- turn 进行中从手机再发消息会排队（inbox 语义），当前 turn 结束后自动处理。
- resume 一个冷会话后它就在本进程 live 了；此后 TUI 再 `/resume` 同一个会话属未定义
  行为（单操作者纪律下不会发生）。
- 绑定关系、think 显示开关、最近聊天位置都持久化在 dsh settings 的 `dsh-feishu`
  namespace，重启 dsh 后：live 的会话自动重新附着；冷的等你在手机上第一次说话时
  才 lazy 恢复（启动阶段绝不主动发消息、绝不抢着 resume 占坑）。

## 配置参考

### patch 配置（`config:` 块）

| key | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `"on"` | `"off"` 完全停用插件 |
| `domain` | `"feishu"` | `"feishu"`（国内）或 `"lark"`（国际版） |
| `operators` | `[]` | 操作者 open_id 白名单，**必填才激活** |
| `appId` / `appSecret` | — | 明文凭证逃生门，仅本地测试用；优先 credentials/env |
| `appIdRef` | `"dsh-feishu-app-id"` | credentials 服务 ref 名 |
| `appSecretRef` | `"dsh-feishu-app-secret"` | 同上 |
| `statusIntervalMs` | `5000` | 状态卡更新节拍（伪流式默认 5s），范围 [5000, 600000] |
| `bodySegmentChars` | `3500` | 长正文分段阈值，范围 [500, 30000] |
| `resumeListStyle` | `"auto"` | `/resume` 会话列表渲染方式：`auto` 先发表格卡、发送失败自动降级为 markdown 有序列表重发一次；`table` / `list` 强制指定 |

未知 key 会直接报错拒绝启动（typo 不允许静默失效）。

### 凭证来源优先级

```
patch 明文 appId/appSecret  >  DSH_FEISHU_APP_ID/SECRET env  >  credentials refs
```

### 运行时可变状态（settings namespace `dsh-feishu`）

| 字段 | 说明 |
| --- | --- |
| `boundSessionId` | 当前绑定（经 `/resume` 或首次交互写入） |
| `displayThink` | 状态卡尾行显示开关 |
| `lastChatId` | 最近一次操作的私聊——状态卡发到这里 |

无 settings 服务的 profile 里退化为内存态（重启后需重新 `/resume`，其余功能不受影响）。

## 安全模型

- **全程只出站**：一条到飞书长连接网关的 outbound WSS，零入站端口。符合 dsh
  trust-fence「远程访问必须有认证层」的哲学——不需要 Tailscale/反代/隧道那一整层。
- **身份即认证**：飞书租户账号体系自带身份；每条消息校验 sender `open_id` ∈ 白名单，
  白名单外静默忽略。v1 仅私聊，群聊消息一律忽略。
- **单实例锁**：`$TMPDIR/dsh-feishu-bot.lock`（记录 pid，死锁自动抢占）。飞书长连接
  在多客户端下随机分摊事件，锁保证一台机器只有一个 bot 实例。
- **凭证纪律**：App Secret 走 credentials 服务或环境变量；repo 与 settings.yaml 中
  只有 ref 名。
- **只在用户显式动作时建会话**：`agents.create` 仅存在于 `/new` 这一个入口（操作者主动
  开新会话，与 TUI/web 同权），绝不隐式创建；对已 live 的会话只附着、绝不二次 resume。

## 工作原理

```
┌─ dsh 进程 ─────────────────────────────────────────────────┐
│  cordis root fiber                                         │
│   ├─ dsh-base …                                            │
│   ├─ tui-pi fiber（可选共存，互不干扰）                      │
│   └─ feishu-bot fiber（本插件）                              │
│        ├─ LarkClient   WSClient 出站 WSS（唯一外联）         │
│        ├─ SessionBinder  attach(live) / resume(cold)，永不 create │
│        ├─ RunState     firehose event → 纯函数状态机         │
│        └─ Publisher    一 round 一卡（💬 定稿+原文），5s PATCH        │
└────────────────────────────────────────────────────────────┘
             ▲ session/event firehose（无 scope 过滤，含子会话）
             ▼ agents.get/resume/followup/cancel
```

模块地图（`src/`，全部纯逻辑有单测）：

| 模块 | 职责 |
| --- | --- |
| `lark-client.ts` | WS 接收 + REST 发送封装；所有发送 best-effort，飞书故障不影响 dsh |
| `inbound.ts` | receive_v1 payload → 结构化消息（纯函数） |
| `allowlist.ts` | open_id 白名单判定 |
| `commands.ts` | 入站文本 → 意图路由（自有 / 透传 / 拒绝 / prompt） |
| `binder.ts` | attach/resume 绑定核心与 handle 所有权 |
| `run-state.ts` | firehose 事件折叠：rounds/tools/todo/retry/subagent |
| `card.ts` | RunState → schema 2.0 卡片 JSON（header Round/状态 + markdown 章节 + 统计页脚）+ 内容 hash（变化检测）；含 /resume 原生表格卡片（`buildSessionListCard`） |
| `resume-table.ts` | /resume 列表的过滤、排序、并发 inspect |
| `state-store.ts` | settings namespace 持久化 + 内存退化 |
| `index.ts` | 插件入口：配置校验、单实例锁、凭证解析、装配 |

## 故障排查

启动日志对照表（按出现顺序）：

| 日志行 | 含义 | 处理 |
| --- | --- | --- |
| `invalid config — plugin disabled` | config 有未知 key / 数值越界 | 按报错改 patch 配置 |
| `no operators configured — plugin dormant` | `operators` 为空 | 完成[第四步](#第四步配置操作者白名单) |
| `another instance holds the bot lock — this fiber stays dormant` | 别的 dsh 进程占锁 | 杀掉旧进程，或删 `$TMPDIR/dsh-feishu-bot.lock`（确认无存活 pid） |
| `no Lark credentials (tried config/env, then refs …)` | 三源都没读到凭证 | 完成[第三步](#第三步配置凭证)并重启 |
| `startup failed — plugin dormant` | WS 连接失败（凭证错/网络不通） | 核对 App ID/Secret；国内网络确认能访问飞书 |
| `armed (N operator(s), feishu)` | ✅ 正常运行 | — |

运行期问题：

| 现象 | 可能原因 |
| --- | --- |
| armed 但私聊不回 | 你的 open_id 与白名单不符（非白名单静默忽略，无任何回显）；或事件订阅没选长连接；或应用版本没发布 |
| 能聊但 `/resume` 报无持久化服务 | 当前 profile 未配 session persistence 后端 |
| `/resume N` 报选择过期 | 列表 5 分钟 TTL 已过，重发 `/resume` |
| 状态卡一直不更新 | 该轮 turn 是在绑定之前开始的（mid-turn 附着的计数从附着时刻起算，卡片仍会在 turn/end 定稿） |
| 发消息无 👀 | reaction API 权限未开通（`im:message.reactions:write`），失败静默不影响主流程 |
| 改了凭证没生效 | 凭证在启动时解析一次，需重启 dsh |

## 开发与测试

```bash
npm run check    # tsc --noEmit（precheck 自动补链 @deepseek-ai 闭包软链）
npm test         # 构建 + node --test（156 个纯逻辑单测）
npm run build    # 仅构建 lib/
```

测试覆盖：text 工具、allowlist、config 校验、入站解析、run-state 状态机（含畸形事件
不崩溃）、卡片投影与 hash、resume 表格流、命令路由、binder 所有权三分支、单实例锁。

接手/深挖请读 `~/github/docs/handoff/HANDOFF-dsh-feishu.md`（自包含交接文档：
架构不变量、实装现场、联调清单、延后项）。

## 已知边界与路线图

按设计文档的渐进档位：F1 完成通知 ✅ → F4 手机派活 ✅ → F2 进度直播 ✅（状态卡）。

未做（有意延后，非缺陷）：

- **F3 审批到手机**：`ctx.approval` 决议 API 形状待 spike（上游 `packages/user-approval`）
- **`/model` `/think` `/skills` 手机端**：选择器语义，待做文本列表+序号流
- **群聊支持**：@ 触发，安全模型留口
- **卡片按钮回调**（`card.action.trigger`）：v1 全交互走文本命令
- **CardKit 流式卡片**：明确不做（限频 1000/min，QwenPaw #5167 实测教训）；
  30s 节拍原位更新距限频上限三个数量级

其他边界：resume 附着后不回放历史；turn 进行中附着时计数从附着时刻起算；飞书消息
PATCH 有频控但 5s 节拍（≈12 次/分钟）远低于上限；原生流式（CardKit 流式卡片）
设计阶段已否决（限频 1000/min，另起一套卡片体系），伪流式 = 快节拍 + 尾行。

---

*License: MIT。作者 fan56。设计调研：`docs/dsh-feishu-bot-design-research.md`、
`docs/dsh-feishu-bridge-research.md`（workspace docs/ 下）。*

## 问询交互（ask_user_question）

agent 调 ask_user_question 时，bot 发一张 schema 2.0 **form 交互卡**（问题 →
下拉/多选/输入控件 + 📮 提交钮），提交后卡片定稿为 ✅ 已回答、答案回传 dsh。

- **接收回调**：`card.action.trigger` 走长连接。需要**一次性**在飞书开发者后台
  开启：事件与回调 → 长连接模式 → 订阅 `card.action.trigger` + 相关权限并发布。
  未订阅时插件照常运行，只是问询卡收不到提交（卡会一直等待）
- **SDK 补丁**：node-sdk 的 WSClient 会静默丢弃 card 帧（同 python SDK #126），
  已在 lark-client 内做 card→event 帧头重写；升级 SDK 需回归
- **多端路由**：装了 `@aiwayds/dsh-ask-router`（bundles 排 UI 之前）时，本插件
  注册为 surface——与 TUI 面板双端同弹、先答先得；未装路由时直接占 provider 槽
  （被占则让位）。**web profile 不装路由**（上游 apiproxy 不容忍重复注册）
- 只有 operators 白名单内的用户能提交；未答完会提示缺哪项；turn 中止时卡自动
  收起为 ⏹ 已取消
