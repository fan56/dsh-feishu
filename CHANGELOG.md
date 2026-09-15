# Changelog

All notable changes to dsh-feishu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.11.1] - 2026-09-15

### Fixed
- **`/resume` picker metadata through the dsh 0.1.5 persistence seam.** dsh 0.1.5-rc.1 wrapped every `sessionPersistence.list()` entry in a `{header, revision, sizeBytes}` snapshot (was a bare `SessionHeader`) and removed `inspect()` in favor of `open(id, 'read')` + a read-handle drain; the 0.1.5 migration batch missed the resume readers, so every field resolved against the wrapper and each row rendered `#N · ? · undefine · NaN-NaN-NaN NaN:NaN` (`String(undefined).slice(0,8)` plus `new Date(undefined)`) — `/resume N` could not bind either. Ports dsh-tui-pi's seam vocabulary: `headerOf` normalizes both `list()` generations, `readPersistedSession` cold-reads via `open` + drain with the legacy `inspect` as fallback. Consumers fixed alongside: the cold-resume model-route backfill and the binder's persisted-cwd lookup (both silently degrading on 0.1.5 hosts).

## [0.11.0] - 2026-09-14

### Added
- **`/new` config card.** `/new` no longer mints a session outright — it presents one fill-first card (agent preset / model / reasoning effort as dropdowns, preselected from the resolved defaults) and the session is created only on submit; a green summary card replaces it in place. Every dropdown is best-effort: a source that fails just omits its field and the submit falls back to the default-resolution chain.
- **Custom presets on `/new`.** The preset dropdown lists the full host roster — shipped four plus every user-authored preset in the harness home (`~/.dsh/.agent-presets/`), customs marked `· 自定义`, broken compositions hidden; the picked id resolves and mounts through the same host path the Web UI uses.
- **Workspace picker on `/new`.** The first dropdown lists EXISTING workspaces from the host registry (`workspaceRegistry.list()`) — the picked path is the new session's cwd, verbatim. An empty registry replies NA (`无法创建新会话`) instead of sending a card; a profile without the registry keeps the legacy cwd fallback.
- **Agent preset on the stats footer.** The settled round card shows the session's preset (`🧩 standard`), learned at `/new` (the operator's pick) or via the `sessionQuery` projection for attached/resumed sessions; unknown = field omitted.
- **`roundButtons` config (default `off`).** The round card's ⛔ 停止 / ▶️ 继续 quick actions are opt-in (`on`, env `DSH_FEISHU_ROUND_BUTTONS`); off keeps the card clean — `/stop` is the stop path either way.
- **`/stop` two-tap confirmation.** The stop gesture now sends a `⛔ 确认停止 / 返回` card (60 s auto-cancel) and only the confirm tap stops; the sweep also cancels every LIVE child subagent the run state tracks — background/continuable children previously survived the parent cancel and kept burning rounds. btw side calls die with the turn as before.
- **Mojibake repair on body cards.** Model output that arrives UTF-8-read-as-1252 (`ðŸ˜Š`) is re-decoded at the body-card boundary (`😊`); runs that do not decode cleanly (legit European text, CJK) stay verbatim.

### Fixed
- **`/new` (and every bot-created session) now joins an agent preset** — parity with the host's own creators (`composeAgent` / webhook). A bare create composed against the empty global layer: on web/headless profiles the tool plugins load per-agent THROUGH the preset, so bot sessions published with only the `skill` tool (#2). Cold resume rejoins the session's recorded preset from the `agent-preset/selected` projection — a web-created session revived after a host restart used to land in the empty layer again. Failure paths degrade to the bare create (tui profiles load tools globally).
- **Card buttons carry unique names.** Feishu rejects a whole card when a form-submit button shares a `name` with any other button (230099) — the `/new` submit/cancel pair and the selector buttons/confirm-cancel modes all collided; names now carry role/index suffixes with parser fallbacks. A failed `/new` card send replies instead of staying silent.
- **Web-profile compat e2e leg C:** a probe plugin drives the real `SessionBinder` inside a real web-profile host — create joins the default preset (composed + durably projected), a restart + cold resume rejoins it, and a bare control create still detects as unjoined.

## [0.10.0] - 2026-09-12

### Added
- **`agent/turn-stopping` subscription.** A stop/cancel starts reflecting on the round card the moment the loop honors it (`⛔ 停止中` header) instead of waiting for the `turn/end` settlement.
- **`agent/request-error` subscription.** A failed model request shows a one-line `⚠️ 请求失败：…` in the card's activity section immediately, while retries are still scheduled (cleared when a message lands or a new turn starts).
- **Round-card performance footer.** The settled round card now shows first-token latency (`⚡ ttft 200ms`) rebuilt from the embedded `AssistantStreamRecord`, plus the round's output tokens (`📤 25 tok`) from its usage snapshot — the live card stays clean.
- **`/model` picker context windows.** Each model option appends its context window (`· 128k ctx`) when the adapter reports one, resolved in bounded-parallel and fail-open (a resolution failure degrades to the plain catalog).

### Changed
- **btw first-frame throttle.** The very first text delta patches the btw card immediately (the answer appears the moment the first token lands); later deltas still defer to the beat, so no per-delta Lark patch.
- **Web-profile compat e2e** (`npm run e2e`). Runs on the local dsh against an isolated scratch `$DSH_HOME`: proves `dsh-base + dsh-web-app + dsh-feishu` composes and boots, and that a tui profile carrying `dsh-feishu` coexists with the web profile without crashing.

### Fixed
- **Accidental cancel taps.** Approval cards (❌ 拒绝) now require a second tap: the first tap on 取消 swaps to a `确认取消 / 返回选择` interim card, and only the confirm tap settles. Non-approval selectors keep their one-tap cancel.

## [0.9.0] - 2026-09-11

### Removed
- The vendored pid-file writer lock — dsh 0.1.5 enforces cross-process single-writer at the host itself (kernel lease on `session.lock`, contention refuses with `SessionAlreadyOwnedError`), making the vendored `link(2)` pid-file lock redundant for safety and strictly worse everywhere else (pid-reuse misreads, stale residue after SIGKILL, POSIX-only, blind to non-vendoring writers).

### Changed
- **dsh support floor raised to `>= 0.1.5-rc.2`** and the closure moved to 0.1.5-rc.2 (dev pins, peer floors, locks).
- **Live streaming rides `agent/assistant-stream` frames.** The 0.1.5 firehose delivers settlements only, so the status card's thinking marker, in-flight text tail, pending context estimate and child tail rows are now fed by stream frames routed per session id (`foldBoundStreamChunk` / `foldChildStreamChunk`); settlements still arrive on `session/event`.
- **V3 session artifacts** (`session.v3.jsonl[.zstd]`, current generation first) in the read-only remote view, the repair script's log lookup, and the resume-table mtime walk.
- Release: the publish-verify loop polls `npm view` for ~2 min instead of 30s — packument propagation measured ~50s on dsh-dcp v0.11.0 outran the old window and falsely failed a landed publish.


## [0.8.1] - 2026-09-09

### Changed
- The bundled skill is renamed `dsh-feishu` → `dsh-feishu-config` (ecosystem-wide convention: config/usage-guide skills end with `-config`). Bundled skills are registered in-process with zero on-disk footprint — updating the package and restarting dsh migrates the name automatically; the old `/dsh-feishu` slash invocation stops resolving. README skill mention updated.

## [0.8.0] - 2026-09-08

### Added
- **Bundled usage/config skill (`dsh-feishu`)** — the plugin now ships `skills/dsh-feishu/SKILL.md` and registers it through `ctx.skills.registerProvider` (`inject` gains the `skills` seam; registered unconditionally at the top of `apply()`, so the setup guide is served even while the bot is dormant): it documents the cordis.patch.yml `config:` block (all 12 keys with defaults and ranges), the `DSH_FEISHU_*` environment variables, the credentials priority (patch plaintext > env > credentials-service refs), the settings.yaml `dsh-feishu:` runtime-state vs config distinction, a curated phone command table, and troubleshooting — plus an interactive setup flow where the agent checks the Feishu app prerequisites, collects the operators allowlist and the `backgroundPush` mode via `ask_user_question`, and writes the patch `config:` block for the user.
- README (en/zh) gains a "Bundled skill / 内置技能" section; the new `test/skill.test.mjs` guards the routing description against the packaged frontmatter (anti-drift) and the provider registration/get contract.

## [0.7.1] - 2026-09-05

### Fixed
- **Plugin unload settles every pending phone-side flow** — `dispose()` now rejects unanswered ask questions (`ASK_ABORTED`) and cancels in-flight selector/approval flows, flushing their terminal card patches while the WebSocket is still open; previously the host-side callers hung until their own abort/turn end and the cards stayed submittable on the phone.
- **Teardown no longer arms the bot after disposal** — the arm-after-credentials race (the seam wait is bounded, not instant) opened a WebSocket nothing would ever close and re-created the lock file the teardown had already released; a `tornDown` latch closes it.

### Changed
- Clean-uninstall documentation (Uninstall sections in both READMEs) and an uninstall leg in the boot smoke asserting `dsh plugin remove` reconciles the profile tree back to stock.

## [0.7.0] - 2026-09-03

### Changed

- **BREAKING — dsh host floor moves to `>= 0.1.2-rc.1` (supersedes the interim alpha.3 target below)**: all rc/alpha dual paths and feature-detection are gone — single-target on the rc.1 closure
  - ask-user answering registers on the `dsh-ask-router` surface registry when present, otherwise on the Agent-scoped `'user-questions/request'` cordis waterfall only — the rc-era `ctx.userQuestions.registerProvider` slot (and its `DUPLICATE_PROVIDER` yield, via `isDuplicateProviderError`) is deleted
  - `/命令` passthrough calls `commands.execute(agent, line, images, signal)` with the mandatory alpha images array — the `execute.length >= 4` arity probe for the rc.7 three-argument shape is deleted
- **CI/release ride the rolling rc/stable line — the alpha dist-tag is retired**: CI and the release workflow resolve the newest of the `latest` (stable) and `next` (rc) dist-tags at runtime (plain semver compare), never hand-pinned and never `@alpha` — the closure floor moves to the dsh 0.1.2-rc.1 line
- **README declares rc/stable-only support**: `dsh >= 0.1.2-rc.1`, the alpha line is no longer supported

### Added

- **`/btw` — by-the-way side questions from the phone** (parity with dsh-tui-pi's `/btw`, deliberately duplicated with zero package dependency — `docs/adr/0001-btw-duplicated-not-shared.md`): while the bound main line is mid-turn, `/btw <question>` fires one tool-less one-shot model call over a read-only recent-conversation snapshot and streams the answer into its own Feishu card (5s beat, pseudo-streaming, settled in place). Nothing enters the session log, the inbox, or any main-line model request; single-flight with a bounded queue (5); `/new`, `/resume`, `/stop` and dispose cancel phone-side calls (per-surface semantics); the idle main line refuses (a normal message is strictly better there — tools, history, full context); bare `/btw` re-sends the last exchange; `--model provider/model` overrides the route; the `btwContextMessages` config key sizes the snapshot (default 6, clamped 0–50).
- **Approval cards on the host's `approval/request` waterfall**: when the approval service asks for a sandbox escalation, the phone gets a ✅ 允许一次 / ❌ 拒绝 buttons card (selector FW). Claimed when the asking session is the bound one and a delivery chat exists; the request's abort signal cancels the card; expiry and undeliverable sends fail closed as `unavailable`
- **Group chat support**: @-mention dispatch — text and commands after a mention of the bot route exactly like DM (mention placeholders stripped; only allowlisted senders ever trigger); images are accepted from the group that is the bot's current active dispatch surface while a session is bound (image messages cannot carry mentions)
- **Background completion push** (`backgroundPush` config / `DSH_FEISHU_BACKGROUND_PUSH` env, default `off`): completion cards for sessions the phone is not bound to, delivered to the last active chat — `cron` mode pushes turns carrying a cron delivery (`source {kind: 'plugin', plugin: 'cron'}`) or a subagent-settled notice, `all` pushes every finished turn
- **Image dispatch from Feishu**: inbound image messages are downloaded via the resource API, media-type sniffed from magic bytes (png/jpeg/webp/gif), committed through the attachment service (`saveImage`) and injected as an image-block user message through the shared steer/followup channel; size/media admission honors the attachment limits
- **Round-card quick actions**: ⛔ 停止 on running cards, ▶️ 继续 on ended cards — one-tap stop (the /stop path) and a continue nudge injected as a prompt; parsed from the button value with the name-prefix fallback, gated by the operator allowlist
- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI — CI gates on it; CI also gains a daily schedule and installs the host from the rolling `@alpha` dist-tag (latest still points at the dropped rc line).
