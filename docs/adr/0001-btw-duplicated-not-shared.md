# 0001 — btw is duplicated into dsh-feishu, not shared

`/btw`（主线运行中顺带一问，旁路单次调用）先在 dsh-tui-pi@1.1.0 落地，随后
手机端 dsh-feishu 也要求同一能力。第二个 surface 的出现满足了
dsh-tui-pi `docs/adr/0001`（TUI-owned）预留的抽取触发条件，但本次**刻意不抽
共享包**：引擎（参数解析、快照组装、单飞队列、流消费、controller）以逐行
复制的方式落进本仓库 `src/btw.ts`，两个插件之间零依赖——用户拍板「插件独立，
功能一致，不要有依赖，代码可以重复」。

## Considered options

- **共享纯库包 `@aiwayds/dsh-btw`** — 拒绝：为两个消费方新建一个包、一次
  跨仓库发布编排和两处依赖升级，买到的只是"单一事实源"；用户判定复制成本
  更低。已知代价：修 bug 必须双仓同步（两个 `test/btw.test.mjs` 矩阵保持
  一致即为对账机制）。
- **cordis 服务插件（`ctx.btw` seam）** — 拒绝：在只有两个 surface 的今天
  预付了 N 面协同的抽象债（跨插件生命周期、加载顺序、统一并发点）。
- **将来若第三面（Web UI）也要 btw**：那是重新评估共享包/服务插件的触发
  条件——届时以两份复制品的合并为起点，而不是从零设计。

## Consequences

- 并发与取消是 **per-surface** 的：手机队列/Last-btw 槽/取消钩子
  （`/new`、`/resume`、`/stop`、dispose）与 TUI 的 overlay 互不感知；
  "最多 1 个旁路调用"是每个 surface 各自的约束。
- 两份实现的行为契约以各自的测试矩阵对账：`test/btw.test.mjs`（本仓库）
  与 `dsh-tui-pi` 同名测试文件保持用例一一对应。
- 文案语言有意不同：TUI 英文（其 AGENTS.md 铁律），手机端中文（本仓库
  bot 回复惯例）。
