# dsh-feishu — 用飞书驾驶 dsh

> [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）伴生插件：
> 把**已存在的** dsh 会话接到手机上——派活、看进度、答问询、收回复。
> 只出站 WebSocket，不开端口、不要内网穿透。

---

## ✨ 亮点

- **Round 卡实时直播**：每个 LLM 往返一张卡——当前状态（🤔 thinking / 🔧 工具 / ⏳ 子代理）、
  工具调用、生成中的正文尾行，**5 秒伪流式**刷新
- **交互式问询**：agent 调 ask_user_question 时，手机弹**交互卡**（下拉/多选/文本输入 + 提交），
  答完即回传；配 [ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) 可与
  桌面 TUI **双端同弹、先答先得**
- **交互式 /resume**：会话列表卡片上直接**下拉选择 → 点进入**，也可以回复 `/resume N`
- **`/new` 开新会话**：自动继承旧会话的工作目录、模型和推理档位
- **手机派活**：turn 进行中发消息默认 **steer**（并入当前 turn，纠偏即时生效）
- **远程急停**：`/stop` 随时中止；白名单外的人私聊 bot 完全隐身

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

## 📱 使用

| 命令 | 说明 |
| --- | --- |
| `/resume` | 交互式会话选择卡（下拉+进入；也可回复 `/resume N`），列表按最近更新排序 |
| `/new` | 开一个全新会话并接入（继承工作目录、模型和推理档位） |
| `/stop` | 停止当前 turn（排队消息保留） |
| `/status` | 绑定与运行状态 |
| `/sub N` | 查看第 N 个子代理近况 |
| `/feishu-plugin think on\|off` | 开关活动区的思考尾行（默认开） |
| `/goal` `/dcp` `/export` `/agents` `/subagents` | 透传给 dsh 执行 |
| 其它任何文本 | 作为 prompt 注入当前会话（运行中则 steer 进当前 turn） |

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
npm test         # 构建 + node --test（173 个纯逻辑单测）
```

## 边界

- v1 仅私聊；群聊、审批流（卡片交互层已就绪）在路线图上
- resume 附着后不回放历史；turn 进行中附着时计数从附着时刻起算
- web profile 请勿安装 ask-router（上游 apiproxy 不容忍重复注册）

---

*License: MIT. 作者 fan56.*
