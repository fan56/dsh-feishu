# dsh-feishu

> [English](README.md) | [简体中文](README.zh.md)

Drive an existing [dsh](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness) session from Feishu/Lark on your phone — dispatch work, watch progress live, answer questions, get the results. Outbound-only WebSocket: no open ports, no tunnels.

---

## ✨ Highlights

- **Live round cards**: one card per LLM round-trip — current state (🤔 thinking / 🔧 tool / ⏳ subagent), tool calls, and a growing tail of the in-flight message, refreshed every **5 seconds** (pseudo-streaming)
- **Interactive ask-user cards**: when the agent calls `ask_user_question`, your phone gets an **interactive card** (dropdown / multi-select / text input + submit); the answer flows straight back. Pair it with [ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) for **both desktop and phone prompting — first answer wins**
- **Interactive /model**: pick a model on the phone, grouped by provider —
  bot-created sessions switch live
- **Interactive /resume**: pick a session from the card (dropdown + enter), or just reply `/resume N`
- **`/new` starts a fresh session** that inherits the previous one's working directory, model and reasoning effort
- **Phone dispatch**: messages sent mid-turn default to **steer** (they join the running turn — course corrections land immediately)
- **Remote stop**: `/stop` aborts anytime; non-allowlisted users are completely invisible to the bot

## 🎬 Demo

**`/new` starts a fresh session; dispatch work right from the phone:**

https://github.com/user-attachments/assets/177e8839-523b-487e-b3d1-6d725cd8aba5

**`/resume` interactive session picker + answering an ask-user card:**

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

## 🚀 Install & Configure

### Step 1: Create the Feishu app (web, ≈10 min)

Sign in at [open.feishu.cn](https://open.feishu.cn) → create a **Custom App** (企业自建应用):

1. Note the `App ID` (starts with `cli_`) and `App Secret`
2. "Add app capability" → **Bot**
3. "Events & callbacks" → subscription mode **Long connection**; add events:
   `im.message.receive_v1` (messages) and `card.action.trigger` (card
   interactions — required by the ask cards and the /resume picker)
4. Permissions: `im:message:send_as_bot`, `im:message.p2p_msg:readonly`,
   `im:message.reactions:write`
5. Availability: add yourself → **create a version and publish** (events don't
   flow until you publish — the most common stumbling block)

### Step 2: Install the plugin into your profile (≈2 min)

```bash
git clone git@github.com:fan56/dsh-feishu.git ~/github/dsh-feishu
cd ~/github/dsh-feishu && npm install && npm run link-closure
```

Edit `~/.dsh/profiles/<your-profile>/package.json`:

```jsonc
{
  "dsh": { "profile": { "bundles": [
    // …existing bundles…
    "@aiwayds/dsh-feishu"          // ← add
  ]}},
  "dependencies": {
    // …existing deps…
    "@aiwayds/dsh-feishu": "link:/path/to/dsh-feishu"   // ← add
  }
}
```

```bash
cd ~/.dsh/profiles/<your-profile> && pnpm install
```

### Step 3: Credentials (≈1 min)

```yaml
# ~/.dsh/.credentials.yaml (chmod 600; restart dsh after changing)
dsh-feishu-app-id: cli_xxxxxxxxxx
dsh-feishu-app-secret: xxxxxxxxxxxxxxxx
```

### Step 4: Allowlist (≈1 min)

Only allowlisted Feishu users can use the bot — everyone else is invisible:

```yaml
# ~/.dsh/cordis.patch.yml
- id: dsh-feishu
  config:
    operators:
      - ou_xxxxxxxxxxxxxx     # your open_id (admin console → member details)
```

### Step 5: Recommended — add ask-router (multi-surface prompting)

```bash
npm install -g @aiwayds/dsh-ask-router
```

Add `@aiwayds/dsh-ask-router` to `bundles`, **after dsh-base and before any UI
bundle**. With it: phone cards and the desktop TUI panel prompt
**simultaneously — first answer wins**. Without it things still work — the
phone owns prompting when no other UI is present, otherwise the desktop UI
takes it.

### Start & verify

```bash
dsh --profile <your-profile>
# the log line dsh-feishu: armed (1 operator(s), feishu) means success
```

DM the bot `/help` → you get the command list; `/resume` lists sessions; send
text to dispatch work.

## 📱 Usage

| Command | What it does |
| --- | --- |
| `/resume` | Interactive session picker card (dropdown + enter; or reply `/resume N`), sorted by last update |
| `/new` | Start a brand-new session and bind to it (inherits cwd, model and reasoning effort) |
| `/stop` | Abort the running turn (queued messages survive) |
| `/status` | Binding and run status |
| `/sub N` | Inspect the Nth subagent |
| `/model` | **Interactive model picker** (two steps: pick a provider → pick one of its models); live-switches bot-created sessions, otherwise saved as the phone default (applies to /new) |
| `/feishu-plugin think on\|off` | Toggle the reasoning tail in the activity section (default on) |
| `/goal` `/dcp` `/export` `/agents` `/subagents` | Not adapted for the phone yet (interactive desktop panels) — replies point to the desktop |
| Any other text | Injected as a prompt into the bound session (steered into the running turn when one is live) |

Typical flow:

```
Session running on your desktop → open Feishu on the train → /resume and pick it
→ keep going from the phone (auto-steer) → answer ask cards with a tap → /stop anytime
```

## ⚙️ Configuration (`config:` block)

| key | default | description |
| --- | --- | --- |
| `operators` | `[]` | open_id allowlist — **required to arm the bot** |
| `mode` | `"on"` | `"off"` disables the plugin entirely |
| `domain` | `"feishu"` | `"feishu"` (CN) or `"lark"` (international) |
| `statusIntervalMs` | `5000` | round-card refresh beat (pseudo-streaming), range [5000, 600000] |
| `bodySegmentChars` | `3500` | long-body segmentation threshold |
| `resumeListStyle` | `"auto"` | `/resume` list: `auto`/`table`/`list` |
| `appIdRef` / `appSecretRef` | `DSH_FEISHU_APP_ID/SECRET` | credentials ref names |

Credential resolution order: plaintext in patch > `DSH_FEISHU_APP_ID/SECRET` env
vars > the credentials service.

## 🧯 Troubleshooting

| Symptom | Fix |
| --- | --- |
| Log: `no operators configured — dormant` | Allowlist missing (Step 4) |
| Log: `no Lark credentials` | Credentials missing (Step 3); restart after changing |
| Log: `startup failed` | Wrong App ID/Secret, network blocked, or the app version isn't published |
| Bot ignores DMs | Your open_id isn't in the allowlist (non-allowlisted users are silently ignored) |
| Ask card taps do nothing | `card.action.trigger` isn't subscribed (Step 1.3) |
| `/resume N` says expired | The list lives 5 minutes — send `/resume` again |

## Development

```bash
npm run check    # tsc --noEmit
npm test         # build + node --test (173 pure-logic unit tests)
```

## Boundaries

- Single-writer guard: the cold arm of `/resume` and `/new` compete for a
  `writer.lock` beside the session dir before touching disk — when another
  process is driving that session, takeover is refused with the holder's pid
  instead of silently forking the log into interleaved seq numbers; same-process
  attach (shared agent instance) bypasses the lock and behaves as before; a refused `/resume` degrades into a READ-ONLY watch over the persisted log — the phone still receives every turn's final reply (poll-delayed, no streaming detail)
- v1 is DM-only; group chats and the approval flow (the card layer is already
  built) are on the roadmap
- After attaching, session history is not replayed; counters start from attach
  time when a turn is already running
- Never install ask-router into a **web** profile (the upstream apiproxy does
  not tolerate duplicate provider registrations)

---

*License: MIT. Author fan56.*
