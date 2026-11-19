# 设计：宿主 0.2.2-rc.x 下飞书收不到 ask 卡片 — 插件侧修复（prepend + race）

- 日期：2026-11-19
- 设计：blocky（架构 agent）；事实核验：workhorse（rc.4/rc.5 源码实测）；评审：oldfox（GO-with-changes，B1/B2 已并入）
- 关联 issue：fan56/dsh-feishu#7
- 状态：评审通过（带变更），待实现

## 1. 已核实事实（F1–F8）

| # | 事实 | 出处 |
|---|---|---|
| F1 | agent 存在时派发：`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { ...request, agent }, noAnswerer)`；全仓唯一派发点 | `@deepseek-ai/dsh-user-questions/src/index.ts:344-353`（本机 rc.4；V3 已核唯一性） |
| F2 | 宿主 client bridge answerer：`enabled && agent!==undefined && ownsAgent(agent)` 则 `this.ask(...)` 消费、不 next()；`enabled` 由 initialize 握手 `capabilities.userQuestions===true` 置位；`ownsAgent`=session 句柄同一性 | `dsh-sdk-jsonrpc-server/src/user-questions.ts:20-24`、`server.ts:251`、`server.ts:144-145` |
| F3 | 后果：GUI 打开过的 session 插件 answerer 永远收不到；bot 创建、GUI 没开过的 session 正常 | issue #7 + rc.4 源码 |
| F4 | rc.5（2026-11-18，latest/next）相关代码与 rc.4 逐字一致，官方未修，无 fan-out/竞速 | rc.5 tarball diff 实测 |
| F5 | Cordis waterfall：`callbacks.shift()` 顺序执行，listener 调 next() 才继续，head 返回值胜出；`ctx.on` 第三参 `boolean \| { prepend?, global? }`，`prepend:true` unshift 到队头；`register` 一律走 ctx.fiber.effect（生命周期与 options 无关）；next 重复调用有守卫 | cordis `src/events.ts:96,110-116,246-279` |
| F6 | scope filter 对 untagged listener 放行（`tag === undefined → true`），插件无 scope 注册能收到任意 agent-scoped 派发 | `dsh-scope/src/index.ts:173-181` |
| F7 | 本仓现状：`registerAskSurface()` src/bot.ts:2335-2359 启动期无 scope 无 options 注册；`ctx.get('askSurfaces')` 存在则走 `router.register` 并 return（2337-2348）；claim=`request.agent.session.id === binder.getSessionId()`，无 agent 视为认领（2362-2368）；`askViaCard()` 2377-2407（NO_CHAT 同步 reject 2380-2382；CARD_SEND_FAILED 2400-2403；signal abort→ASK_ABORTED 2388-2392；发卡在途时 chain 回调补 cancelled 灰卡 2395-2398）；答案靠 waterfall 返回值回传；`dismissAsk()` 2411-2419（删 pending+reject ANSWER_ELSEWHERE，发卡未落地时 patch 空转）；`onCardAction` 对已删 pending 直接 return（2548-2549）；卸载全量 reject ASK_ABORTED（529-533）；config 14 键（118-122）无 ask 开关 | 本仓实测（main@255e914） |
| F8 | bridge `ask()` 监听复合 signal（`AbortSignal.any([request.signal, questionShutdown])`），abort 时发 `user-question.cancelled` 关闭 GUI 弹窗；**答案提交后不 abort signal**；派发方拿到返回值后也不 abort | `dsh-sdk-jsonrpc-server/src/user-questions.ts:36-56`、`dsh-user-questions/src/index.ts:344-360` |

补充：
- V1 结论：GUI 陈旧弹窗结构性成立（v1 不自愈），但 v1.1「胜出后定向 abort signal」可行（bridge 监听 signal）。
- V2 结论：`noAnswerer` 是纯 `NO_PROVIDER` rejected Promise（dsh-user-questions:340-343），无 TUI 交互；「bot session 双提示」风险解除，askRace 默认值无需翻转。
- V4 结论：ask-router 源码仓在我们手里（`/Users/qingguee/repo/dsh-ask-router`，fan56，0.7.0，main@2fe5d62），answerer 注册点 `src/index.ts:154` 无 scope 无 options → 走路线 a（给 router 打同款补丁）。

结论：宿主侧监听顺序问题。插件侧可控杠杆 = 注册顺序（prepend）+ 是否继续传递（next 调用方式）。

## 2. 约束

C1 只改本仓 + dsh-ask-router 仓；C2 答案唯一回传通道是 listener 返回值；C3 Cordis 语义以源码为准；C4 未 bound session 行为与现状逐字节一致；C5 无新持久化/卡片 schema 变更。

未决范围问题：approval/request 同病（bridge 对 approval 同样 claim 后不 next，`dsh-sdk-jsonrpc-server/src/server.ts:124-127`；本仓 `registerApprovalSurface` bot.ts:2438-2448 在 rc.4/rc.5 GUI-opened session 同样收不到）——是否纳入本期，待用户拍板（见 §12）。

## 3. 主方案：standalone 路径 prepend + race

### 3.1 注册改动

唯一改动点 `src/bot.ts registerAskSurface()`：`askRace=true` 时第三参传 `{ prepend: true }`；`=false` 时不传 options，保持字节级旧行为。沿用仓内结构化 cast 风格。不做运行时探测 prepend 是否生效（旧版仅认 boolean 时 truthy object 仍按 prepend 处理；若被忽略则尾部注册=修复前行为，退化安全）。

**不传 `global` 的理由（更正）**：`global` 不影响 listener 生命周期（`register` 一律走 `ctx.fiber.effect`，F5），只影响派发过滤（`events.ts:169-170` 的 `hook.global || !filter || filter(...)`）。不传 global 是为了保持 scope filter 语义、维持今天的接收行为；生命周期已由 ctx 保证，无需 global。

### 3.2 状态机（B1/B2 修订版）

```
DISPATCHED (F1 waterfall)
  └─> [我方 prepended listener]
        ├─ claimsAskSession()==false ──> return next()            # 未 bound，行为不变（C4）
        ├─ askRace==false ────────────> return askViaCard(request) # legacy 独占（=现状）
        └─ race 模式：
              同 tick fork 两路（同一 tick 内两路都挂 handler，堵 unhandledRejection）：
                downstream = new Promise(resolve => resolve(next()))  # 同步 throw 自动变 reject
                card       = Promise.resolve().then(() => askViaCard(request))
              仲裁器 settled 单向闸，先 settle 者胜：
                R-A card 先 resolve      → 返回飞书答案；downstream 晚到结果/拒绝一律吞掉（GUI 陈旧弹窗=F8/v1.1）
                R-B downstream 先 resolve → dismissAsk(entry) 灰卡撤卡（复用 F7 机制）→ 返回 GUI 答案
                R-C 两路皆 reject：
                      request.signal?.aborted == true  → 透传 ASK_ABORTED（现状语义）；
                        注意时序：signal abort 时 downstream 也会先 reject 被吞，card 是仅存路径，
                        其 ASK_ABORTED 必须透传，不得再吞
                      request.signal?.aborted != true  → 双 reject 终态：优先透传 card 的错误码
                        （NO_CHAT 可诊断性最强）；card 为 NO_CHAT/CARD_SEND_FAILED 时回落 downstream
                R-D card 非 abort 拒绝（NO_CHAT/CARD_SEND_FAILED/卸载），downstream 仍 pending
                      → 视为 card 路死亡，吞掉，等 downstream 结果（飞书不可用不应拖垮 GUI）
                R-E 插件卸载（dispose）且 signal 未 abort → 视为 card 路死亡，等 downstream
                      → 仲裁器 promise 允许晚于插件 ctx dispose 才 settle（downstream 属宿主侧，存活不受影响）；
                        dispose() 现有注释（bot.ts:525-528"settle every phone-side interactive flow"）需同步修订
                R-F card 先 reject（非 abort/非卸载）、downstream 后 resolve → 返回 downstream 答案（同 R-D 出口）
```

关键点：
- 先调 next() 再发卡（next 同步发起下游链，飞书有 API 往返延迟）。
- 不主动 abort `request.signal`（signal 归派发方，语义是「取消提问」非「他处已答」）；v1.1 在 F8 支持下可加「胜出后定向 abort 收 GUI 弹窗」增强。
- card 路 settle 出口实际有 5 个：作答 / signal / 卸载 / NO_CHAT / CARD_SEND_FAILED（后两者是构造器内同步 reject，同 tick 挂 handler 即可不触发 unhandledRejection）。
- R-B 细节：dismissAsk 可能在发卡在途时（messageId undefined）patch 空转，askViaCard chain 回调会补 cancelled 灰卡（F7 2395-2398）——现有机制兜住，测试覆盖。
- R-B 后僵尸卡提交：onCardAction 对已删 pending 直接 return（F7 2548-2549），安全，测试覆盖。

### 3.3 仲裁器契约（签名级）

```ts
raceAskSurfaces(
  card: Promise<AskAnswers>,
  downstream: Promise<AskAnswers>,
  onDownstreamWin: (entry: PendingAskEntry) => void,  // 复用 dismissAsk
): Promise<AskAnswers>
```

配套：`askViaCard()` 向调用方暴露 pendingAsks entry 句柄（R-B 撤卡用）。仲裁器硬性要求：fork 同 tick 给两路都挂 handler。

### 3.4 next() 并发安全（对照 cordis 源码）

1. 先 next() 再返回自己答案：允许（head 返回值胜出；下游 dangling promise fork 时挂 catch）。
2. next() 每次派发恰好一次（cordis 有重复调用守卫 events.ts:253-254；实现仍加断言）。
3. next() 同步 throw：包装 `new Promise(resolve => resolve(next()))` 统一变 reject（如 api-remotes forwarder 对 scoped 事件缺 agent 的同步 TypeError → R-D）。
4. 无死锁：card 路 5 个 settle 出口全覆盖；downstream 单独 block 不了仲裁器。
5. 未 bound session：直接 next()，链与今天一致。

### 3.5 运行时数据

无持久化变更。pendingAsks entry 增加 `downstream?: Promise<unknown>`、`settled: boolean` 瞬态字段。

## 4. router 路径（V4=路线 a）

ask-router 仓在手（fan56/dsh-ask-router 0.7.0），给 `src/index.ts:154` 的 answerer 打同款 prepend+race 补丁（注册点同构：无 scope 无 options），与 feishu standalone 同步实施。

feishu 的 `askRouterTakeover` 只作为旧版 router 的逃生门：默认 `false`（路线 a 下不需要 takeover）；`true` 时跳过 `router.register` 自行 prepend+race。**代价（oldfox concern）**：takeover 后 router 的其他 surface 被 demote 到 bridge 之后，GUI-opened session 上可能丢失其他面（不止失去 router 仲裁），迁移说明必须写明。

**禁止**：既 router.register 又自行 prepend（router 会再发一张卡，双卡）。

默认值一旦发布不再翻转（配置键=公共契约）；若未来需要，用运行时按 router 版本探测，不翻默认。

## 5. 兼容性矩阵（oldfox 修订）

| 宿主 | ask-router | 配置 | 行为 | 判定 |
|---|---|---|---|---|
| <0.2.2 | 无 | askRace=true | 双弹竞速（chain 只剩我方 → next() 直达 noAnswerer NO_PROVIDER 被吞，card 应答） | 机械等价旧行为；唯一分歧=双 reject 错误码（B1 已钉） |
| <0.2.2 | 无 | askRace=false | 现状独占 | 不变 |
| rc.4/rc.5 | 无 | askRace=true | 卡+GUI 竞速先答胜 | **修复目标态** |
| rc.4/rc.5 | 无 | askRace=false | GUI 独占无卡（=bug） | 逃生门 |
| 任意 | 0.7.0 已打补丁 | 默认 | router prepend+race | 修复 |
| 任意 | 旧版 router | takeover=true | feishu 自行 prepend+race | 修复；router 其他面 demote（已知代价） |
| 任意 | 旧版 router | takeover=false | 现状 router 路径 | bug 仍在（等 router 升级） |
| 官方修复（保持 waterfall 契约：透传/竞速/signal 收败者） | 任意 | 默认 | 我们仍调 next()，天然共存 | 兼容；无双答无死锁 |
| 官方修复（改变契约：parallel/换事件/mode 可配置） | 任意 | 默认 | listener 收到的 next 可能消失，claims-false 路径 next() 抛错 | **不兼容**：rc.6 重验时先核对派发 mode（api-remotes remote-events.ts:57 表明 mode 是可配置面） |

## 6. 配置项（src/config.ts，三处：CONFIG_KEYS / Config / ResolvedConfig；14→16 键）

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `askRace` | boolean | true | prepend 注册 + bound session 双 surface 竞速；false=完全现状 |
| `askRouterTakeover` | boolean | false | 仅 askSurfaces 存在且 askRace=true 时有意义：true=跳过 router.register 自行 race（旧 router 逃生门） |

配套：env 覆盖 `DSH_FEISHU_ASK_RACE` / `DSH_FEISHU_ASK_ROUTER_TAKEOVER`（对齐 roundButtons/toolDetail 既有模式 config.ts:161-170）。

## 7. 上游 issue 要点（@deepseek-ai/dsh）

- 标题：user-questions/request exclusively consumed by the JSON-RPC client bridge — plugin answerers never receive asks for GUI-opened sessions (0.2.2-rc.4/rc.5)
- 机制：F1/F2 源码点；F8 佐证「bridge 监听 signal，但 waterfall 提前返回时无人 abort → 陈旧弹窗结构性存在」。
- 影响：GUI 打开过的 session 插件 answerer 静默收不到，无报错；**approval/request 同形独占**（server.ts:124-127）。
- 期望：coexistence race 或官方仲裁机制；文档化 waterfall listener 顺序契约；事件链已有 waterfall 良民共存者（api-remotes forwarder）佐证 coexistence 是既有惯例。
- 附社区 workaround（prepend+race）及缺陷，说明为何需宿主层解决。

## 8. 被否备选

| # | 备选 | 否决理由 |
|---|---|---|
| N1 | 掐 capabilities.userQuestions（篡改握手） | 一刀切禁 GUI 应答破坏既有工作流；握手协议归宿主，版本一变即碎 |
| N2 | monkey-patch 宿主运行时 | 宿主升级静默回滚/崩；不可维护，违反 C1 |
| N3 | prepend + 独占抢答（不 race） | 把 GUI 独占镜像成飞书独占，换受害者；与双 surface 共存预期相悖 |
| N4 | 只发 issue 等官方 | rc.4→rc.5 零变化且 rc 是 latest，等待期全部 rc 用户无卡 |
| N5 | scope 镜像注册 | 病根是顺序不是 scope（F5/F6） |

## 9. 风险（V1/V2/V3/V4 后修订）

- R1 GUI 陈旧弹窗（R-A 后）：结构性存在（F8），v1 不处理；v1.1 定向 abort 增强可行。
- R2 prepend 影响面：唯一派发点已核（V3），护栏=claimsAskSession 前置过滤不满足即 next()；链上另有 api-remotes forwarder，request 原样传递不破坏其 agent 断言。
- R3 ~~noAnswerer TUI 双提示~~ **已销案**（V2：纯 NO_PROVIDER reject，无 TUI 交互）。
- R4 多 prepend 竞争：按加载逆序排列，多方竞速语义自洽。
- R5 官方修复形态：矩阵已按契约变更形态收窄；rc.6 发布重验矩阵 3/4/8/9 行。
- R6（新）approval 同病遗留：若本期不修，GUI-opened session 的 approval 卡片仍收不到（半愈症状），需在 issue/README 说明。
- 不可逆点：配置键发布即公共契约（默认值不翻转）；prepend 双弹对用户可见。

## 10. ADR

**ADR-dsh-feishu-0001：user-questions 应答面从「尾部独占认领」改为「prepend 注册 + 与下游竞速共存」。** 决策：`registerAskSurface` 以 `{prepend:true}` 注册（仅 askRace=true）；bound session 同 tick fork next() 下游链与 askViaCard，先 settle 者胜：飞书胜透传答案吞下游，下游胜 dismissAsk 灰卡透传，两路皆 reject 且 signal.aborted 透传 ASK_ABORTED，card 非 abort 拒绝（含卸载）回落 downstream，双 reject 优先透传 card 错误码；不主动 abort signal；ask-router 仓同步打同款补丁（路线 a），takeover 仅作逃生门默认 false。代价：双弹竞速 UX、GUI 陈旧弹窗遗留（v1.1）、approval 同病待拍板（R6）、新增 2 配置键+env 长期契约；官方契约不变的修复下自然共存无需移除。

## 11. 落地

- Phase 0 ✅（V1/V2/V3/V4 全部核验完毕）
- Phase 1（实现）：§3 注册改动 + 仲裁器 + pendingAsks 微扩 + 2 配置键 + env 覆盖 + 单测/集成测试
- Phase 2：dsh-ask-router 同款补丁
- Phase 3：上游 issue + rc.6 跟踪

测试清单（oldfox §7）：
1. R-D：card 非 abort 拒绝（NO_CHAT 同步 / CARD_SEND_FAILED）时 downstream pending——两个时序各一例
2. 双 reject 终态与错误码断言（pre-0.2.2 + NO_CHAT 组合）
3. R-E：race 进行中 dispose，downstream 存活；signal abort 且 downstream 先 reject、card 后 reject 的透传用例
4. downstream 胜时发卡在途（messageId undefined）→ 灰卡补丁
5. downstream 胜后僵尸卡提交被忽略
6. next() 恰好一次断言
7. 真实 cordis EventsService 验 prepend 排序（先注册尾 listener 再 prepend，断言先执行）
8. 真机：rc.5 GUI-opened session 四场景（phone 先答 / GUI 先答 / 中途 abort / 卸载热重载）+ pre-0.2.2 回归 + router 在场场景

## 12. 范围决定（2026-11-19 用户拍板）

- approval/request 同病：**本期一起修**——prepend + race 同款平移，R6 解除；approval 的状态机与测试按 §3.2 同规格执行（host claim 点 `server.ts:124-127`，本仓 `registerApprovalSurface` bot.ts:2438-2448）。

## 13. 验证结果（2026-11-19，独立验证 agent）

- 两仓独立重跑：feishu `tsc` 0 错 + 537/537；router `tsc` 0 错 + 21/21 + smoke PASS（真实 dsh 启动）。
- diff 审查：文件集合与声称一致，无 commit/push。
- 仲裁器 R-A~R-F 逐条 PASS；prepend 排序用例用真实 cordis EventsService（非 fake）。
- SDK 级集成（真实 rc.4 `SdkUserQuestionBridge` + 真实 cordis + 真实 router apply）：修复态 plugin listener 先调用、bridge 未抢先、答案=plugin；尾部注册对照态 bridge 饿死 plugin（harness 有效性验证）。
- 两项低危发现：
  1. router 双 reject 无 cardDeathCodes 回落（surface NO_CHAT 直接胜出）——符合 ADR「优先透传 surface 错误码」原文，router 无 typed 错误体系，**记录为预期差异，不修**。
  2. router 下游胜后僵尸答案可致重复 settled——**已修**：`settledOnceDispatcher`（每 race Set<surface> 去重，index.ts:103-110,117-123,160,187,217,236-240,257），新增回归测试，22/22 绿。
- 结论：可进入发版。
