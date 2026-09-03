# Changelog

All notable changes to dsh-feishu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**: all rc/alpha dual paths and feature-detection are gone, single-target alpha only
  - ask-user answering registers on the `dsh-ask-router` surface registry when present, otherwise on the Agent-scoped `'user-questions/request'` cordis waterfall only — the rc-era `ctx.userQuestions.registerProvider` slot (and its `DUPLICATE_PROVIDER` yield, via `isDuplicateProviderError`) is deleted
  - `/命令` passthrough calls `commands.execute(agent, line, images, signal)` with the mandatory alpha images array — the `execute.length >= 4` arity probe for the rc.7 three-argument shape is deleted

### Added

- **`/btw` — by-the-way side questions from the phone** (parity with dsh-tui-pi's `/btw`, deliberately duplicated with zero package dependency — `docs/adr/0001-btw-duplicated-not-shared.md`): while the bound main line is mid-turn, `/btw <question>` fires one tool-less one-shot model call over a read-only recent-conversation snapshot and streams the answer into its own Feishu card (5s beat, pseudo-streaming, settled in place). Nothing enters the session log, the inbox, or any main-line model request; single-flight with a bounded queue (5); `/new`, `/resume`, `/stop` and dispose cancel phone-side calls (per-surface semantics); the idle main line refuses (a normal message is strictly better there — tools, history, full context); bare `/btw` re-sends the last exchange; `--model provider/model` overrides the route; the `btwContextMessages` config key sizes the snapshot (default 6, clamped 0–50).
- **Approval cards on the host's `approval/request` waterfall**: when the approval service asks for a sandbox escalation, the phone gets a ✅ 允许一次 / ❌ 拒绝 buttons card (selector FW). Claimed when the asking session is the bound one and a delivery chat exists; the request's abort signal cancels the card; expiry and undeliverable sends fail closed as `unavailable`
- **Group chat support**: @-mention dispatch — text and commands after a mention of the bot route exactly like DM (mention placeholders stripped; only allowlisted senders ever trigger); images are accepted from the group that is the bot's current active dispatch surface while a session is bound (image messages cannot carry mentions)
- **Background completion push** (`backgroundPush` config / `DSH_FEISHU_BACKGROUND_PUSH` env, default `off`): completion cards for sessions the phone is not bound to, delivered to the last active chat — `cron` mode pushes turns carrying a cron delivery (`source {kind: 'plugin', plugin: 'cron'}`) or a subagent-settled notice, `all` pushes every finished turn
- **Image dispatch from Feishu**: inbound image messages are downloaded via the resource API, media-type sniffed from magic bytes (png/jpeg/webp/gif), committed through the attachment service (`saveImage`) and injected as an image-block user message through the shared steer/followup channel; size/media admission honors the attachment limits
- **Round-card quick actions**: ⛔ 停止 on running cards, ▶️ 继续 on ended cards — one-tap stop (the /stop path) and a continue nudge injected as a prompt; parsed from the button value with the name-prefix fallback, gated by the operator allowlist
- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI — CI gates on it; CI also gains a daily schedule and installs the host from the rolling `@alpha` dist-tag (latest still points at the dropped rc line).
