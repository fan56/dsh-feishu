# dsh-feishu — 用飞书驾驶 dsh

> [English](README.md) | 简体中文

> [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）伴生插件：
> 把**已存在的** dsh 会话接到手机上——派活、看进度、答问询、收回复。
> 只出站 WebSocket，不开端口、不要内网穿透。

**要求 dsh >= 0.1.2-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

---

## ✨ 亮点

- **Round 卡实时直播**：每个 LLM 往返一张卡——当前状态（🤔 thinking / 🔧 工具 / ⏳ 子代理）、
  工具调用、生成中的正文尾行，**5 秒伪流式**刷新
- **Round 卡快捷按钮**：turn 进行中是 ⛔ 停止，结束后是 ▶️ 继续——免打字一键操作
- **权限审批卡**：宿主审批瀑布（沙箱提权等）发问时，手机弹 **✅ 允许一次 / ❌ 拒绝** 卡——
  人不在电脑前，长任务不再卡死在权限提示上（会话审批策略须为 `ask`；过期即拒绝，绝不默认放行）
- **交互式问询**：agent 调 ask_user_question 时，手机弹**交互卡**（下拉/多选/文本输入 + 提交），
  答完即回传；配 [ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) 可与
  桌面 TUI **双端同弹、先答先得**
- **群聊支持**：把机器人拉进飞书群——@它 即可派活、执行命令（仅白名单成员可触发，其余人完全隐身）；
  在机器人正驱动的群里，发图**无需 @** 直接进会话
- **图片派活**：私聊直接发图——自动下载、嗅探格式、落成持久附件引用，以图像块注入会话
  （会话的模型路由需支持图像输入）
- **后台完成推送**（`backgroundPush`）：给手机**未绑定**的会话发完成卡——cron 投递与子代理结算
  （`cron` 模式），或每个回合结束（`all` 模式）；默认关闭，不主动打扰
- **交互式 /model**：手机上按 provider 分类选模型，bot 建的会话实时切换
- **桌面选择器上手机**：`/think`（思考档位）、`/permission`（权限 preset）、
  `/select-skill`（技能激活）、`/profile-switch`（模型 profile）——桌面端的选择器
  在手机上变成一键点选卡
- **交互式 /resume**：会话列表卡片上直接**下拉选择 → 点进入**，也可以回复 `/resume N`
- **坏日志一键修复**：/resume 遇到损坏的会话日志（多为历史双写者写入所致）时，手机上弹修复确认卡——原地重建日志（原件保留为备份）并直接进入会话
- **`/new` 开新会话**：自动继承旧会话的工作目录、模型和推理档位
- **手机派活**：turn 进行中发消息默认 **steer**（并入当前 turn，纠偏即时生效）
- **远程急停**：`/stop` 随时中止；白名单外的人私聊 bot 完全隐身
- **顺带一问**：`/btw` 在主线跑着的时候旁路提问，答案流式打进独立卡片——主线完全无感（与 dsh-tui-pi 的 `/btw` 同功能，刻意复制而非共享依赖）

## 🎬 Demo

**`/new` 开新会话，手机直接派活：**

https://github.com/user-attachments/assets/177e8839-523b-487e-b3d1-6d725cd8aba5

**`/resume` 交互式进入会话 + 问询卡答题：**

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

## 🚀 安装与配置

### 第一步：创建飞书应用（网页操作，≈10 分钟）

登录 [open.feishu.cn](https://open.feishu.cn) → 创建「企业自建应用」：

1. 记下 `App ID`（`cli_` 开头）和 `App Secret`
2. 「添加应用能力」→ **机器人**
3. 「事件与回调」→ 订阅方式选 **长连接**，添加事件：
   `im.message.receive_v1`（收消息）和 `card.action.trigger`（卡片交互——
   问询卡与 /resume 选择卡需要）
4. 权限管理开通：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、
   `im:message.group_msg:readonly`（群聊派活）、
   `im:message.resources:readonly`（图片下载）、
   `im:message.reactions:write`
5. 可用范围加自己 → **创建版本并发布**（不发布事件不通，最常见的卡点）

### 第二步：安装插件到 profile（≈2 分钟）

```bash
git clone git@github.com:fan56/dsh-feishu.git ~/github/dsh-feishu
cd ~/github/dsh-feishu && npm install && npm run link-closure
```

编辑 `~/.dsh/profiles/<你的 profile>/package.json`：

```jsonc
{
  "dsh": { "profile": { "bundles": [
    // …现有 bundles…
    "@aiwayds/dsh-feishu"          // ← 新增
  ]}},
  "dependencies": {
    // …现有依赖…
    "@aiwayds/dsh-feishu": "link:/path/to/dsh-feishu"   // ← 新增
  }
}
```

```bash
cd ~/.dsh/profiles/<你的 profile> && pnpm install
```

### 第三步：配置凭证（≈1 分钟）

```yaml
# ~/.dsh/.credentials.yaml （权限 600；改完重启 dsh 生效）
dsh-feishu-app-id: cli_xxxxxxxxxx
dsh-feishu-app-secret: xxxxxxxxxxxxxxxx
```

### 第四步：白名单（≈1 分钟）

只有白名单内的飞书用户能使用 bot，其余人私聊完全隐身：

```yaml
# ~/.dsh/cordis.patch.yml
- id: dsh-feishu
  config:
    operators:
      - ou_xxxxxxxxxxxxxx     # 你的 open_id（管理后台成员详情页可查）
```

### 第五步：推荐加装 ask-router（多端问询）

```bash
npm install -g @aiwayds/dsh-ask-router
```

bundles 里加 `@aiwayds/dsh-ask-router`，放在 **dsh-base 之后、所有 UI 之前**。
装了它：手机问询卡与桌面 TUI 面板**双端同弹、先答先得**。不装也能用——
手机独占问询（无其它 UI 时），或桌面 TUI 面板优先。

### 启动并验证

```bash
dsh --profile <你的 profile>
# 日志出现 dsh-feishu: armed (1 operator(s), feishu) 即成功
```

私聊 bot 发 `/help` → 回命令清单；`/resume` 看会话列表；发文本即派活。

## 🗑️ 卸载

从 profile 移除插件：

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-feishu
```

宿主会自动收敛：`dsh.profile.bundles` 条目被移除，patch 层（`dsh-feishu` 插入项及其配置）随包消失。

以下内容有意保留在磁盘上（删除数据是破坏性的；重装后会继续复用）：

- `~/.dsh/settings.yaml` 的 `dsh-feishu:` 段 —— 绑定的会话 id、picker 样式、手机端偏好；想重置配对就删掉这一段。
- 会话目录里的修复产物：`*.corrupt-bak*` 是损坏日志修复前的唯一副本 —— 请保留；`*.repaired.*` 是修复后重写的日志。
- `/tmp/dsh-feishu-bot.lock` 只在 SIGKILL 后可能残留；下次启动的 stale-pid 检查会自动接管，无需手动处理。

插件卸载（reload、disable、进程退出）会结算手机端所有进行中的交互：未回答的提问/审批/选择卡片会被补丁到终态，宿主侧等待方快速失败而不是悬挂。

## 📱 使用

| 命令 | 说明 |
| --- | --- |
| `/resume` | 交互式会话选择卡（下拉+进入；也可回复 `/resume N`），列表按最近更新排序 |
| `/new` | 开一个全新会话并接入（继承工作目录、模型和推理档位） |
| `/stop` | 停止当前 turn（排队消息保留） |
| `/btw <问题>` | **顺带一问**：主线任务运行中发起旁路提问——一次无工具的模型调用（带最近对话快照），答案流式打进独立卡片，主线完全无感。不进会话记录；主线空闲时拒绝；`--model provider/model` 临时换模型；空参 `/btw` 重发上一条问答（`btwContextMessages` 配置快照条数） |
| `/status` | 绑定与运行状态 |
| `/sub N` | 查看第 N 个子代理近况 |
| `/model` | **交互式模型选择**（两步：选 provider → 选该 provider 下的模型）；bot 建的会话实时切换，否则存为手机默认（/new 生效） |
| `/think` | **交互式思考档位选择**（当前模型的推理档位 + provider 默认）；bot 建的会话实时切换，否则存为手机默认 |
| `/permission` | **交互式权限 preset 选择**；选中后以 `/permission <name>` 走 dsh 命令注册表执行 |
| `/select-skill` | **交互式技能选择**（当前工作区用户可调用的技能）；激活走 dsh 原生 `/name` 技能手势 |
| `/profile-switch` | **交互式模型 profile 切换**（读 `$DSH_HOME/model-profiles.json`）；应用该 profile 的 provider/model/effort（agent frontmatter 更新仍在电脑端） |
| `/feishu-plugin think on\|off` | 开关活动区的思考尾行（默认开） |
| `/settings` `/preset` `/theme` `/reload` `/hotkeys` `/model-sync` `/export` `/agents` `/subagents` `/profile-cfg` `/login` `/logout` `/skills` | 桌面端 **dsh-tui-pi** 插件提供（交互面板）——手机端会拒绝并引导去电脑端（有手机侧替代的附提示，如 `/skills` → `/select-skill`） |
| `/goal` `/dcp` | dsh 运行时存在但暂未适配——拒绝并引导去电脑端 |
| `/session` | 镜像为 `/status` |
| 任何图片消息 | 下载后以图像块注入当前会话（私聊直接生效；群聊仅在该群是当前活跃派活面时）。模型路由需支持图像输入 |
| 其它任何文本 | 作为 prompt 注入当前会话（运行中则 steer 进当前 turn） |

**群聊用法**：把机器人拉进飞书群后 @它 即可——`@dsh 帮我跑一下测试` 与私聊派活完全一致；
命令（`/resume`、`/stop` …）同样先 @ 再发。只有白名单成员能触发机器人，其余成员完全隐身。
卡片会发进派活的群；绑定本身仍是 bot 全局唯一的一个会话（同一时间一个会话，跟随最近派活的聊天）。

典型流程：

```
电脑上会话跑到一半 → 地铁上打开飞书 → /resume 选会话
→ 发消息接着干（自动 steer）→ agent 问询时手机点选 → /stop 随时叫停
```

## ⚙️ 配置参考（`config:` 块）

| key | 默认 | 说明 |
| --- | --- | --- |
| `operators` | `[]` | open_id 白名单，**必填才激活** |
| `mode` | `"on"` | `"off"` 完全停用 |
| `domain` | `"feishu"` | `"feishu"`（国内）或 `"lark"`（国际版） |
| `statusIntervalMs` | `5000` | round 卡刷新节拍（伪流式），范围 [5000, 600000] |
| `bodySegmentChars` | `3500` | 长正文分段阈值 |
| `resumeListStyle` | `"auto"` | `/resume` 列表：`auto`/`table`/`list` |
| `backgroundPush` | `"off"` | 手机未绑定会话的完成推送（发到最后活跃的聊天）：`off` / `cron`（带 cron 投递或子代理结算通知的回合）/ `all`（所有回合结束）。环境变量覆盖：`DSH_FEISHU_BACKGROUND_PUSH` |
| `appIdRef` / `appSecretRef` | `DSH_FEISHU_APP_ID/SECRET` | credentials ref 名 |

凭证解析优先级：patch 明文 > 环境变量 `DSH_FEISHU_APP_ID/SECRET` > credentials 服务。

## 🧯 故障排查

| 现象 | 处理 |
| --- | --- |
| 启动日志 `no operators configured — dormant` | 白名单没配（第四步） |
| `no Lark credentials` | 凭证没配（第三步），改后需重启 |
| `startup failed` | App ID/Secret 错误或网络不通；应用未发布版本 |
| 私聊不回 | open_id 与白名单不符（非白名单静默忽略） |
| 问询卡点了没反应 | 后台未订阅 `card.action.trigger`（第一步第 3 条） |
| `/resume N` 报过期 | 列表 5 分钟有效，重发 `/resume` |

## 开发

```bash
npm run check    # tsc --noEmit
npm test         # 构建 + node --test（230+ 个纯逻辑单测）
```

## 边界

- 单写者守卫：`/resume`（冷恢复臂）与 `/new` 落盘前会在会话目录竞争 `writer.lock`——另一个进程正驱动该会话时，这里会明确拒绝接管并提示持有者 pid，从根上杜绝两套 seq 交错导致的日志损坏；同进程 attach（共享 agent 实例）不经过锁，行为不变；被拒的 `/resume` 自动降级为**只读旁观**——轮询对端落盘日志，最终 LLM 回复照常同步到手机（有延迟、无流式过程）
- 群聊以 @提及为门控，且与 bot 的全局唯一绑定共享：同一时间一个会话，卡片跟随最近派活的聊天；
  群图片仅在该群是当前活跃派活面时接收
- 审批卡走宿主 `approval/request` 瀑布，沿用选择器 10 分钟 TTL；过期或投递失败的审批一律
  fail-closed 返回 `unavailable`——绝不隐式放行
- resume 附着后不回放历史；turn 进行中附着时计数从附着时刻起算
- web profile 请勿安装 ask-router（上游 apiproxy 不容忍重复注册）

---

*License: MIT. 作者 fan56.*
