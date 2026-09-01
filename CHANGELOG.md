# Changelog

All notable changes to dsh-feishu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**: all rc/alpha dual paths and feature-detection are gone, single-target alpha only
  - ask-user answering registers on the `dsh-ask-router` surface registry when present, otherwise on the Agent-scoped `'user-questions/request'` cordis waterfall only — the rc-era `ctx.userQuestions.registerProvider` slot (and its `DUPLICATE_PROVIDER` yield, via `isDuplicateProviderError`) is deleted
  - `/命令` passthrough calls `commands.execute(agent, line, images, signal)` with the mandatory alpha images array — the `execute.length >= 4` arity probe for the rc.7 three-argument shape is deleted

### Added

- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI — CI gates on it; CI also gains a daily schedule and installs the host from the rolling `@alpha` dist-tag (latest still points at the dropped rc line).
