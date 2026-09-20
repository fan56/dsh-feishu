# dsh-feishu

> [English](README.md) | [简体中文](README.zh.md)

Drive an existing [dsh](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness) session from Feishu/Lark on your phone — dispatch work, watch progress live, answer questions, get the results. Outbound-only WebSocket: no open ports, no tunnels.

**Requires dsh >= 0.1.5-rc.2** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.**

---

## ✨ Highlights

- **One-command onboarding**: `/feishu-onboard` on the desktop — scan-to-create the Feishu app, auto-writes credentials + operators, hot-activates without a restart
- **Self-serve pairing**: empty allowlist → the first DM claims admin via a one-tap card
- **Live round cards**: one card per LLM round-trip — current state (🤔 thinking / 🔧 tool / ⏳ subagent), tool calls, and a growing tail of the in-flight message, refreshed every **5 seconds** (pseudo-streaming)
- **Replies land in the round card**: when a round settles, its answer embeds into the very card you were watching — a `💬 Round 回复` section right above the stats footer — instead of arriving as a bare message wedged between status cards (answers longer than one body segment still ship as their own cards)
- **Quick actions on the round card**: ⛔ 停止 while a turn runs, ▶️ 继续 once it ends — one tap instead of typing
- **Approval cards**: when the host's approval waterfall asks for a sandbox escalation, the phone gets a **✅ 允许一次 / ❌ 拒绝** card — an unattended run no longer stalls at the desk (the session's approval policy must be `ask`; expiry fails closed)
- **Interactive ask-user cards**: when the agent calls `ask_user_question`, your phone gets an **interactive card** (dropdown / multi-select / text input + submit); the answer flows straight back. Pair it with [ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) for **both desktop and phone prompting — first answer wins**
- **Group chats**: pull the bot into a Feishu group — @-mention it to dispatch work or run commands (allowlisted members only, silent to everyone else); in the group the bot is actively driving, images flow **without** a mention
- **Image dispatch**: send a picture in DM — it is downloaded, media-type sniffed, committed as a durable attachment and injected into the session as an image block (the session's model route must accept image input)
- **Background push** (`backgroundPush`): completion cards for sessions the phone is *not* bound to — cron deliveries and subagent settlements (mode `cron`), or every finished turn (mode `all`); off by default, the bot never messages unprompted unless told to
- **Interactive /model**: pick a model on the phone, grouped by provider —
  bot-created sessions switch live
- **Interactive pickers for the desktop selectors**: `/think` (reasoning
  effort), `/permission` (permission preset), `/select-skill` (skill
  activation) and `/profile-switch` (model profiles) render as one-tap
  selection cards on the phone
- **Interactive /resume**: pick a session from the card (dropdown + enter), or just reply `/resume N`
- **One-tap corrupt-log repair**: if /resume hits a damaged session log (historical double-writer writes), the bot offers a repair card — it rebuilds the log in place (the original is kept as a backup) and re-enters the session
- **`/new` starts a fresh session** that inherits the previous one's working directory, model and reasoning effort
- **Phone dispatch**: messages sent mid-turn default to **steer** (they join the running turn — course corrections land immediately)
- **Remote stop**: `/stop` aborts anytime; non-allowlisted users are completely invisible to the bot
- **By-the-way questions**: `/btw` fires a side question alongside the running task and streams the answer into its own card — the main line never notices (parity with dsh-tui-pi's `/btw`, duplicated not shared)

## 🎬 Demo

**`/new` starts a fresh session; dispatch work right from the phone:**

https://github.com/user-attachments/assets/177e8839-523b-487e-b3d1-6d725cd8aba5

**`/resume` interactive session picker + answering an ask-user card:**

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

## 🚀 Install & Configure

### Step 1: Install the plugin into your profile (≈2 min)

**From npm (recommended):**

```bash
dsh plugin --profile <your-profile> add @aiwayds/dsh-feishu
```

**Or from a git checkout** (when hacking on the plugin itself):

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

### Step 2: Configure the bot — pick one

`/feishu-onboard` is a **desktop** command — run it in the dsh TUI on your
computer (from the phone it replies with a pointer back to the desktop). The
three options below mirror the three paths the command offers.

#### Option A — `/feishu-onboard` (recommended, ≈2 min, no Feishu console needed)

Run `/feishu-onboard` — in the TUI or the web UI. It asks a handful of
questions one by one through dsh's native ask prompt (web: the question card
pops right in the browser, scoped to your open session; no ask provider or no
live session? it degrades to a plain printed guide) and picks the path with
you:

- **Scan to create the app** — zero Feishu console work
- **Bind an app you already have** — see Option B
- **Manual guide** — see Option C

On the scan path the launcher link arrives as a question card — web: right
in the browser (TTY also renders a QR code) → open it on your phone or
desktop, confirm in Feishu, then tap 「我已完成确认」 → the plugin creates an
enterprise custom app for you via Feishu's
official scan-to-create flow (OAuth device flow, official SDK `registerApp`),
pre-provisioned with everything this plugin needs:

- Bot capability
- Long-connection events: `im.message.receive_v1`, `card.action.trigger`
- Permissions: `im:message:send_as_bot`, `im:message.p2p_msg:readonly`,
  `im:message.group_at_msg:readonly`, `im:message.resources:readonly`,
  `im:message.reactions:write`, `im:chat:readonly`

Then it finishes the job: `app_id`/`app_secret` are written into the dsh
credentials service (refs `DSH_FEISHU_APP_ID` / `DSH_FEISHU_APP_SECRET`), the
scanning user is added as an operator, and the plugin **hot-activates in the
same process** — no dsh restart. Scan, then DM the bot; that's the whole
setup.

> Fine print: the preset permissions ride a platform gray release. Where the
> gray hasn't landed, the command verifies them automatically and guides the
> top-up with a permission-preselection deep link. And for **colleagues** to
> use the bot you still publish it once under Version Management & Release
> (not needed for your own use).

#### Option B — You already have a Feishu app

Two ways to hand the credentials to the plugin:

- **Run `/feishu-onboard` and pick "existing app"**: enter App ID / App Secret
  (written only to the local credentials file — never into session logs) →
  the command verifies them against the API on the spot; wrong credentials
  are re-asked; if the app lacks the bot capability (error code `11205`) the
  credentials are still saved and a console fix checklist is printed. You can
  also add your own open_id as an operator there.
- **Or write the two files yourself**:

```yaml
# ~/.dsh/.credentials.yaml (chmod 600; restart dsh after changing)
DSH_FEISHU_APP_ID: cli_xxxxxxxxxx
DSH_FEISHU_APP_SECRET: xxxxxxxxxxxxxxxx
```

Only allowlisted Feishu users can use the bot — everyone else is invisible:

```yaml
# ~/.dsh/cordis.patch.yml
- id: dsh-feishu
  config:
    operators:
      - ou_xxxxxxxxxxxxxx     # your open_id (admin console → member details)
```

The effective allowlist is a union: `operators` here ∪
`dsh-feishu.pairedOperators` in `~/.dsh/settings.yaml` (written by pairing
mode and `/feishu-onboard`) ∪ the `DSH_FEISHU_OPERATORS` env var
(comma-separated open_ids — handy for quick local tests without editing the
patch).

#### Option C — Manual console setup

Prefer driving the [open.feishu.cn](https://open.feishu.cn) console yourself?
Six steps (≈10 min) — once they're done, return to **Option B** to hand the
credentials to the plugin:

1. **Create the app**: sign in at open.feishu.cn → create a **Custom App**
   (企业自建应用); note the `App ID` (starts with `cli_`) and `App Secret`
2. **Add the bot**: "Add app capability" → **Bot**
3. **Permissions** ("Permissions & management"): `im:message:send_as_bot`,
   `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly` (group
   @-mention dispatch), `im:message.resources:readonly` (image download),
   `im:message.reactions:write`, `im:chat:readonly`. Shortcut: the
   permission-preselection deep link
   `https://open.feishu.cn/app/{AppID}/auth?q=...&op_from=openapi` pre-ticks
   the scopes — the same link `/feishu-onboard` hands you when a preset scope
   isn't gray-released for your tenant
4. **Events & callbacks**: subscription mode **Long connection**; add the
   events `im.message.receive_v1` (messages) and `card.action.trigger` (card
   interactions — required by the ask cards and the /resume picker)
5. **Availability → version & publish**: add yourself under Availability,
   then **create a version and publish** — events don't flow until you
   publish (the most common stumbling block)
6. **Credentials**: they belong in `~/.dsh/.credentials.yaml` (chmod 600;
   restart dsh after changing) — paste the Option B yaml by hand, or run
   `/feishu-onboard` → "existing app" and let it store and verify them

### Step 3: Start & verify

```bash
dsh --profile <your-profile>
# the log line dsh-feishu: armed (1 operator(s), feishu) means success
```

DM the bot `/help` → you get the command list; `/resume` lists sessions; send
text to dispatch work.

**Operators list still empty?** The bot no longer sits fully dormant: with
valid credentials and no operators it stays connected in **pairing mode** —
anyone who DMs it receives an **admin pairing** confirmation card, and one tap
claims admin (first come, first served; persisted to
`dsh-feishu.pairedOperators` in `~/.dsh/settings.yaml`, effective immediately,
no restart). Group chats never trigger it, and once the list has an admin,
everyone outside it is invisible again. On a shared tenant that means the
first colleague to DM the bot becomes its admin — if that's not what you
want, DM it yourself first, or pre-configure `operators` per Option B.

## 🔀 Recommended: add ask-router (multi-surface prompting)

```bash
npm install -g @aiwayds/dsh-ask-router
```

Add `@aiwayds/dsh-ask-router` to `bundles`, **after dsh-base and before any UI
bundle**. With it: phone cards and the desktop TUI panel prompt
**simultaneously — first answer wins**. Without it things still work — the
phone owns prompting when no other UI is present, otherwise the desktop UI
takes it.

## 🗑️ Uninstall

Remove the plugin from a profile:

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-feishu
```

The host reconciles the profile automatically: the `dsh.profile.bundles` entry is spliced and the patch layer (the `dsh-feishu` insert with its config) is dropped.

What stays on disk (kept on purpose — deleting data is destructive; a reinstall reuses it):

- `~/.dsh/settings.yaml` `dsh-feishu:` section — bound session id, picker style, phone-model preference, and `pairedOperators` (the paired-admin list written by pairing mode / `/feishu-onboard`). Delete the section to reset the pairing — admins included.
- Repair artifacts inside session dirs: `*.corrupt-bak*` is the only pre-repair copy of a damaged session log — keep it; `*.repaired.*` is the rewritten log the repair produced.
- `/tmp/dsh-feishu-bot.lock` can linger after a SIGKILL; the stale-pid check steals it on the next start, so no manual step is needed.

Plugin unload (reload, disable, process exit) settles pending phone-side flows: unanswered ask/approval/selection cards are patched to a terminal state and their host-side callers fail fast instead of hanging.

## 📱 Usage

| Command | What it does |
| --- | --- |
| `/resume` | Interactive session picker card (dropdown + enter; or reply `/resume N`), sorted by last update |
| `/new` | Start a brand-new session and bind to it (inherits cwd, model and reasoning effort) |
| `/stop` | Abort the running turn (queued messages survive) |
| `/btw <question>` | **By-the-way side question** while the main task runs: one tool-less model call over a recent-conversation snapshot, streamed into its own card — the main line never notices. Not kept in the session; idle main line refuses; `--model provider/model` overrides the route; bare `/btw` re-sends the last exchange (`btwContextMessages` config sizes the snapshot) |
| `/status` | Binding and run status |
| `/sub N` | Inspect the Nth subagent |
| `/model` | **Interactive model picker** (two steps: pick a provider → pick one of its models); live-switches bot-created sessions, otherwise saved as the phone default (applies to /new) |
| `/think` | **Interactive reasoning-effort picker** for the current model (adapter-provided efforts + provider default); live-switches bot-created sessions, otherwise saved as the phone default |
| `/permission` | **Interactive permission-preset picker**; the pick is replayed as `/permission <name>` through the dsh command registry |
| `/select-skill` | **Interactive skill picker** (user-invocable skills of the bound workspace); activation rides dsh's native `/name` skill gesture |
| `/profile-switch` | **Interactive model-profile switcher** over `$DSH_HOME/model-profiles.json`; applies the profile's provider/model/effort (agent frontmatter updates remain desktop-only) |
| `/feishu-plugin think on\|off` | Toggle the reasoning tail in the activity section (default on) |
| `/settings` `/preset` `/theme` `/reload` `/hotkeys` `/model-sync` `/export` `/agents` `/subagents` `/profile-cfg` `/login` `/logout` `/skills` | Provided by the desktop **dsh-tui-pi** plugin (interactive panels) — the phone refuses them with a desktop pointer (and a phone-side stand-in hint where one exists, e.g. `/skills` → `/select-skill`) |
| `/goal` `/dcp` | Exist in the dsh runtime but not yet adapted — refused with a desktop pointer |
| `/session` | Mirrored to `/status` |
| Any image message | Downloaded and injected into the bound session as an image block (DM: directly; group: only while that group is the active dispatch surface). Requires the model route to accept image input |
| Any other text | Injected as a prompt into the bound session (steered into the running turn when one is live) |

**Group usage**: add the bot to a Feishu group, then @-mention it — `@dsh 帮我跑一下测试` dispatches exactly like a DM; commands (`/resume`, `/stop`, …) work the same way after a mention. Only allowlisted members ever trigger the bot; everyone else is invisible. Cards land in the group while the dispatches keep coming from there; the binding itself stays the bot's single global one (one session at a time, whichever chat drove it last).

Typical flow:

```
Session running on your desktop → open Feishu on the train → /resume and pick it
→ keep going from the phone (auto-steer) → answer ask cards with a tap → /stop anytime
```

## ⚙️ Configuration (`config:` block)

| key | default | description |
| --- | --- | --- |
| `operators` | `[]` | open_id allowlist — the effective list is the union of this, `dsh-feishu.pairedOperators` (settings.yaml) and `DSH_FEISHU_OPERATORS` (comma-separated open_ids); an empty list boots the bot into pairing mode |
| `mode` | `"on"` | `"off"` disables the plugin entirely |
| `domain` | `"feishu"` | `"feishu"` (CN) or `"lark"` (international) |
| `statusIntervalMs` | `5000` | round-card refresh beat (pseudo-streaming), range [5000, 600000] |
| `bodySegmentChars` | `3500` | long-body segmentation threshold — also the embed ceiling: a settled round's body at or under it rides the round card itself (`💬 Round 回复` section) instead of shipping as separate message(s); values outside [500, 30000] error the plugin off |
| `resumeListStyle` | `"auto"` | `/resume` list: `auto`/`table`/`list` |
| `backgroundPush` | `"off"` | Completion push for sessions the phone is not bound to, into the last active chat: `off` / `cron` (turns carrying a cron delivery or a subagent-settled notice) / `all` (every finished turn). Env override: `DSH_FEISHU_BACKGROUND_PUSH` |
| `roundButtons` | `"off"` | Quick-action buttons on round cards: `on` renders ⛔ 停止 under the live card and ▶️ 继续 under the ended card; `off` keeps both out — the `/stop` command (with its own confirmation) is the stop path either way. Env override: `DSH_FEISHU_ROUND_BUTTONS` |
| `appIdRef` / `appSecretRef` | `DSH_FEISHU_APP_ID/SECRET` | credentials ref names |

Credential resolution order: plaintext in patch > `DSH_FEISHU_APP_ID/SECRET` env
vars > the credentials service.

## 🧩 Bundled skill

The plugin ships a bundled skill (`dsh-feishu-config`): ask the agent to set up or
configure the Feishu bot and the guide loads automatically — it checks the
prerequisites (Feishu app, credentials), collects the operators allowlist and
the `backgroundPush` mode via `ask_user_question`, writes the `config:` block
above for you, and walks the phone-side pairing. It also documents the full
config key table, the `DSH_FEISHU_*` env vars, and the runtime-state
(`settings.yaml` `dsh-feishu:` section) vs config distinction.

## 🧯 Troubleshooting

| Symptom | Fix |
| --- | --- |
| Log shows `pairing mode` | Expected with credentials set but an empty allowlist: the bot runs in pairing mode — the first person to DM it gets the admin-pairing card and can claim admin with one tap. Pre-configure `operators` (Option B) to skip pairing |
| Others can't use the bot | No published version covers them: create a version under **Version Management & Release** and publish, and keep them inside the availability scope |
| Log: `no Lark credentials` | Credentials missing (Option B); restart after changing |
| Log: `startup failed` | Wrong App ID/Secret, network blocked, or the app version isn't published |
| Bot ignores DMs | Your open_id isn't in the allowlist (non-allowlisted users are silently ignored) |
| Ask card taps do nothing | `card.action.trigger` isn't subscribed (Option C, step 4) |
| `/resume N` says expired | The list lives 5 minutes — send `/resume` again |

## Development

```bash
npm run check    # tsc --noEmit
npm test         # build + node --test (230+ pure-logic unit tests)
```

## Boundaries

- dsh 0.1.6 compatibility (upstream B-21): resuming a session saved under
  dsh 0.1.5-rc.2 whose subagent completion notices carried reasoning content
  fails to serialize the first model request (host-side data issue, not a
  plugin defect). When `/resume` of an rc.2-era session fails this way, run
  `/new` and start a fresh session instead.
- Single-writer guarantee (host-native since dsh 0.1.5): cold-resuming a
  session another process is driving is refused by the host's kernel write
  lease (`SessionAlreadyOwnedError`) instead of silently forking the log into
  interleaved seq numbers; same-process attach (shared agent instance) never
  opens a second write handle and behaves as before; a refused `/resume`
  degrades into a READ-ONLY watch over the persisted log — the phone still
  receives every turn's final reply (poll-delayed, no streaming detail), and
  queued follow-ups take over automatically once the other process lets the
  session go
- Group chats are mention-gated and share the bot's single global binding:
  one bound session at a time, whichever chat dispatched last receives the
  cards. A group image is accepted only from the chat that is currently the
  active dispatch surface
- Approval cards ride the host's `approval/request` waterfall with the
  standard selector TTL (10 min); an expired or undeliverable approval fails
  closed as `unavailable` — never an implicit allow
- After attaching, session history is not replayed; counters start from attach
  time when a turn is already running
- Never install ask-router into a **web** profile (the upstream apiproxy does
  not tolerate duplicate provider registrations)

---

*License: MIT. Author fan56.*
