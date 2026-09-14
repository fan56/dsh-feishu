#!/usr/bin/env bash
# web-profile compat e2e — runs on the LOCAL dsh (no container, no Lark).
#
# Verifies the scenarios the phone plugin must survive when the desktop
# runs a web profile alongside it:
#
#   leg A — web-profile composition: a profile made of `dsh-base +
#           dsh-web-app + dsh-feishu` must dump a tree containing dsh-feishu
#           and boot the web server cleanly (no loader errors).
#   leg B — tui/web coexistence: the same isolated $DSH_HOME also carries a
#           `tui` profile (`dsh-base + dsh-tui-pi + dsh-feishu`); both
#           profiles boot side by side without crashing, and dsh-feishu
#           (dormant without Lark credentials) never takes the process down.
#   leg C — /new preset composition (issue #2): a probe plugin drives the
#           REAL SessionBinder inside a REAL web-profile host — create must
#           join the default agent preset (meta + composed scope), a restart
#           + cold /resume must rejoin it, and a bare control create must
#           still detect as unjoined (the detector works). Exercises the
#           web-profile tool story: tool plugins are NOT loaded globally
#           there, so a preset-less session publishes with only `skill`.
#
# Everything runs against a scratch $DSH_HOME under mktemp; the real
# ~/.dsh is untouched. The dsh binary is the local one (PATH), and the
# plugins are linked from their local repos like the real profiles do
# (`link:` in package.json), so this exercises the same closure resolution
# the live tui/web profiles use.
#
# Usage:  bash e2e/web-profile-compat.sh   (from anywhere in the repo)

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FEISHU="$REPO_ROOT"
TUI_PI="${TUI_PI:-/Users/qingguee/repo/dsh-tui-pi}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-feishu-e2e-XXXXXX")"
export DSH_HOME="$WORK/home"
mkdir -p "$DSH_HOME"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }
info(){ printf '  [info] %s\n' "$*"; }

cleanup() {
  pkill -f "dsh --profile e2e-web" 2>/dev/null || true
  pkill -f "dsh --profile e2e-tui" 2>/dev/null || true
  pkill -f "dsh --profile e2e-probe" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- scaffold one profile ---------------------------------------------------
scaffold() { # $1=profile-name $2=comma-separated bundle list $3=extra-dependency (optional)
  local name="$1" bundles="$2" extra="${3:-}"
  local dir="$DSH_HOME/profiles/$name"
  mkdir -p "$dir"
  printf '[]\n' > "$dir/cordis.yml"
  printf '[]\n' > "$dir/cordis.patch.yml"
  cat > "$dir/pnpm-workspace.yaml" <<'Y'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
Y
  {
    printf '{\n  "name": "dsh-profile-%s",\n  "private": true,\n' "$name"
    printf '  "dependencies": {\n    "@aiwayds/dsh-feishu": "link:%s"\n' "$FEISHU"
    case "$name" in
      *tui*) printf '    ,"@aiwayds/dsh-tui-pi": "link:%s"\n' "$TUI_PI" ;;
    esac
    if [ -n "$extra" ]; then printf '    ,%s\n' "$extra"; fi
    printf '  },\n  "dsh": { "profile": { "bundles": [%s] } }\n}\n' "$bundles"
  } > "$dir/package.json"
  if ! (cd "$dir" && pnpm install >/dev/null 2>&1); then
    bad "pnpm install failed for profile $name"
    return 1
  fi
}

boot_until_serve() { # $1=profile-name $2=logfile $3=timeout-s
  local name="$1" log="$2" timeout_s="$3" i
  (cd "$DSH_HOME/profiles/$name" && dsh --profile "$name" --port 0 --no-open >"$log" 2>&1 &)
  for i in $(seq 1 "$timeout_s"); do
    if grep -q "http://127.0.0.1" "$log" 2>/dev/null; then return 0; fi
    if grep -qE "plugin tree failed to load|failed to apply loader entry|cannot get required service|Cannot find (package|module)|without inject" "$log" 2>/dev/null; then return 1; fi
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------------ leg A --
info '=== leg A: web-profile composition (dsh-base + dsh-web-app + dsh-feishu) ==='
scaffold e2e-web '"@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@aiwayds/dsh-feishu"'

DUMP="$(cd "$DSH_HOME/profiles/e2e-web" && dsh --profile e2e-web --dump-config 2>&1)"
if printf '%s' "$DUMP" | grep -q "dsh-feishu"; then
  ok 'web-profile tree contains dsh-feishu'
else
  bad 'web-profile tree MISSING dsh-feishu'
  printf '%s\n' "$DUMP" | tail -5
fi

if printf '%s' "$DUMP" | grep -qE "Cannot find|loader error|failed to apply"; then
  bad "web-profile dump carries loader errors: $(printf '%s' "$DUMP" | grep -E "Cannot find|loader error|failed to apply" | head -1)"
else
  ok 'web-profile dump is loader-error free'
fi

if boot_until_serve e2e-web "$WORK/web.log" 30; then
  ok 'web profile (with dsh-feishu) booted and served'
else
  bad 'web profile failed to reach serving state'
  tail -8 "$WORK/web.log" 2>/dev/null | sed 's/^/    | /'
fi
pkill -f "dsh --profile e2e-web" 2>/dev/null || true
sleep 1

# ------------------------------------------------------------------ leg B --
info '=== leg B: tui + web coexistence (both carry dsh-feishu) ==='
scaffold e2e-tui '"@deepseek-ai/dsh-base","@aiwayds/dsh-tui-pi","@aiwayds/dsh-feishu"'

TUI_DUMP="$(cd "$DSH_HOME/profiles/e2e-tui" && dsh --profile e2e-tui --dump-config 2>&1)"
if printf '%s' "$TUI_DUMP" | grep -q "dsh-tui-pi" && printf '%s' "$TUI_DUMP" | grep -q "dsh-feishu"; then
  ok 'tui-profile tree contains dsh-tui-pi and dsh-feishu'
else
  bad 'tui-profile tree missing a plugin'
fi

# Boot web first (it holds the bot lock if credentials existed), then tui.
if boot_until_serve e2e-web "$WORK/web2.log" 30; then
  ok 'web profile booted first'
else
  bad 'web profile (second boot) failed to serve'
fi

(cd "$DSH_HOME/profiles/e2e-tui" && dsh --profile e2e-tui >"$WORK/tui.log" 2>&1 &)
sleep 12
TUI_ALIVE="$(pgrep -f "dsh --profile e2e-tui" | wc -l | tr -d ' ')"
WEB_ALIVE="$(pgrep -f "dsh --profile e2e-web" | wc -l | tr -d ' ')"
if [ "$TUI_ALIVE" -ge 1 ]; then
  ok 'tui profile (with dsh-feishu) stays alive alongside web'
else
  bad 'tui profile died while web ran'
  tail -6 "$WORK/tui.log" 2>/dev/null | sed 's/^/    | /'
fi
if [ "$WEB_ALIVE" -ge 1 ]; then
  ok 'web profile stayed alive alongside tui'
else
  bad 'web profile died while tui ran'
fi

# dsh-feishu without Lark credentials must degrade to dormant, never crash.
if grep -aiE "dsh-feishu.*(dormant|no Lark credentials)" "$WORK/tui.log" 2>/dev/null | head -1 | grep -q .; then
  ok 'tui-side dsh-feishu degraded to dormant without credentials'
else
  # The warn may be suppressed at the TUI log level — the process surviving
  # is the real assertion; note the absence instead of failing.
  info 'tui-side dsh-feishu: no explicit dormant line in log (log-level dependent)'
fi

# ------------------------------------------------------------------ leg C --
info '=== leg C: /new preset composition in a real web profile (probe-driven) ==='

# The probe is authored INTO the scratch profile — throwaway, no repo noise.
# It drives the linked dsh-feishu's REAL SessionBinder against the REAL host
# services (agents / agentPresets / sessionPersistence), the same binder the
# Lark bot uses for /new and /resume.
PROBE_PROFILE="$DSH_HOME/profiles/e2e-probe"
mkdir -p "$PROBE_PROFILE/probe"
cat > "$PROBE_PROFILE/probe/package.json" <<'Y'
{ "name": "dsh-feishu-e2e-probe", "private": true, "type": "module", "main": "index.js" }
Y
cat > "$PROBE_PROFILE/probe/index.js" <<'EOF'
// e2e probe — see e2e/web-profile-compat.sh leg C. Writes one JSON result
// file (FEISHU_PROBE_RESULT) and never throws past its own catch.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

export const name = 'dsh-feishu-e2e-probe'
export const inject = ['agents']

const resultFile = process.env.FEISHU_PROBE_RESULT
const write = data => { try { writeFileSync(resultFile, JSON.stringify(data)) } catch { /* gone */ } }
const presetIdOf = composed =>
  composed === undefined || composed === null ? null : (composed.id ?? String(composed))
// composedPreset throws on a scopeless/absent context — a probe bug must
// surface as DATA, not kill the leg.
const safeComposed = (presets, agent) => {
  try {
    const ctx = agent?.ctx ?? agent
    return presetIdOf(presets.composedPreset?.(ctx))
  } catch (error) {
    return `error: ${String(error)}`
  }
}

async function waitService(ctx, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const service = ctx.get(key)
    if (service !== undefined) return service
    if (Date.now() > deadline) throw new Error(`service "${key}" never appeared`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

export async function apply(ctx) {
  try {
    const presets = await waitService(ctx, 'agentPresets', 20_000)
    await waitService(ctx, 'sessionPersistence', 20_000)
    const expected = (await presets.resolve(undefined)).id
    const { SessionBinder } = await import('@aiwayds/dsh-feishu/lib/binder.js')

    if (process.env.FEISHU_PROBE_MODE === 'resume') {
      // Second boot, fresh process: the target session is NOT live — the
      // binder's cold arm must rejoin the preset recorded in its header.
      const target = readFileSync(process.env.FEISHU_PROBE_SESSION, 'utf8').trim()
      // Diagnostics first: does the projection still carry what /new recorded?
      const obs = await ctx.get('sessionQuery').observeSession(target)
      const binder = new SessionBinder(ctx)
      const bound = await binder.bind(target)
      write({
        leg: 'resume', ok: true, sessionId: bound.sessionId, bindMode: bound.mode,
        expectedPreset: expected,
        targetProjectedPreset: obs?.projections?.values?.agentPreset ?? null,
        composedPreset: safeComposed(presets, bound.agent),
      })
      return
    }

    const binder = new SessionBinder(ctx)
    const created = await binder.createNew(process.cwd())
    // The durable record: the presets service appends `agent-preset/selected`
    // on mount; the host projects it back. This is what a LATER cold resume
    // (next boot) reads — assert it here so the resume leg's premise holds.
    const observation = await ctx.get('sessionQuery').observeSession(created.sessionId)
    const projected = observation?.projections?.values?.agentPreset ?? null
    const persisted = await ctx.get('sessionPersistence').list()
    const header = persisted.find(h => String(h.id) === created.sessionId)
    // Bare control: the PRE-FIX create shape must still detect as unjoined —
    // proves this probe can see the difference (issue #2's exact bug).
    const bareHandle = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: process.cwd() },
    })
    writeFileSync(process.env.FEISHU_PROBE_SESSION, created.sessionId)
    write({
      leg: 'create', ok: true, sessionId: created.sessionId, createMode: created.mode,
      expectedPreset: expected,
      projectedPreset: projected,
      headerPreset: header?.agentPreset ?? null,
      composedPreset: safeComposed(presets, created.agent),
      bareComposedPreset: safeComposed(presets, bareHandle?.agent ?? bareHandle),
    })
  } catch (error) {
    write({ ok: false, error: String((error && error.stack) || error) })
  }
}
EOF

scaffold e2e-probe '"@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@aiwayds/dsh-feishu"' '"dsh-feishu-e2e-probe": "link:./probe"'
cat > "$PROBE_PROFILE/cordis.patch.yml" <<'Y'
- insert:
    - id: feishu-e2e-probe
      name: dsh-feishu-e2e-probe
Y

json_get() { # $1=file $2=key
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2" 2>/dev/null
}

boot_probe() { # $1=mode $2=result-file
  local mode="$1" result="$2"
  rm -f "$result"
  (cd "$PROBE_PROFILE" && FEISHU_PROBE_MODE="$mode" FEISHU_PROBE_RESULT="$result" \
    FEISHU_PROBE_SESSION="$WORK/probe-session.id" \
    dsh --profile e2e-probe --port 0 --no-open >"$WORK/probe-$mode.log" 2>&1 &)
  if wait_file "$result" 60; then
    sleep 1 # let the host settle before the result file is judged
    return 0
  fi
  return 1
}

wait_file() { # $1=file $2=timeout-s
  local i
  for i in $(seq 1 "$2"); do
    [ -s "$1" ] && return 0
    sleep 1
  done
  return 1
}

boot_probe create "$WORK/probe-create.json"
if [ "$(json_get "$WORK/probe-create.json" ok)" = "True" ]; then
  CREATE_MODE="$(json_get "$WORK/probe-create.json" createMode)"
  EXPECTED="$(json_get "$WORK/probe-create.json" expectedPreset)"
  PROJECTED="$(json_get "$WORK/probe-create.json" projectedPreset)"
  COMPOSED="$(json_get "$WORK/probe-create.json" composedPreset)"
  BARE="$(json_get "$WORK/probe-create.json" bareComposedPreset)"
  if [ "$CREATE_MODE" = "created" ]; then
    ok 'probe: binder /new created the session'
  else
    bad "probe: /new did not create (mode=$CREATE_MODE)"
  fi
  if [ -n "$EXPECTED" ] && [ "$PROJECTED" = "$EXPECTED" ]; then
    ok "probe: /new recorded the default preset durably ($PROJECTED)"
  else
    bad "probe: projected preset mismatch (expected '$EXPECTED', got '$PROJECTED')"
  fi
  if [ "$COMPOSED" = "$EXPECTED" ]; then
    ok "probe: /new agent composes under the default preset ($COMPOSED)"
  else
    bad "probe: /new agent composes bare or under the wrong preset ('$COMPOSED' vs '$EXPECTED')"
  fi
  if [ "$BARE" = "None" ] || [ -z "$BARE" ]; then
    ok 'probe: bare control create detects as unjoined (detector works)'
  else
    bad "probe: bare control unexpectedly composed ($BARE) — detector cannot see the bug"
  fi
else
  bad 'probe: create leg produced no/failed result'
  cat "$WORK/probe-create.json" 2>/dev/null | sed 's/^/    | /'
  grep -a "dsh-feishu:" "$WORK/probe-create.log" 2>/dev/null | head -3 | sed 's/^/    | /'
  tail -8 "$WORK/probe-create.log" 2>/dev/null | sed 's/^/    | /'
fi
pkill -f "dsh --profile e2e-probe" 2>/dev/null || true
sleep 2 # kernel write lease must be released before the cold resume boot

boot_probe resume "$WORK/probe-resume.json"
if [ "$(json_get "$WORK/probe-resume.json" ok)" = "True" ]; then
  BIND_MODE="$(json_get "$WORK/probe-resume.json" bindMode)"
  COMPOSED="$(json_get "$WORK/probe-resume.json" composedPreset)"
  EXPECTED="$(json_get "$WORK/probe-resume.json" expectedPreset)"
  TARGET="$(cat "$WORK/probe-session.id" 2>/dev/null)"
  BOUND_ID="$(json_get "$WORK/probe-resume.json" sessionId)"
  if [ "$BIND_MODE" = "resumed" ] && [ "$BOUND_ID" = "$TARGET" ]; then
    ok 'probe: cold /resume took the resume arm (fresh process)'
  else
    bad "probe: cold /resume wrong arm/id (mode=$BIND_MODE, id=$BOUND_ID, want $TARGET)"
  fi
  if [ "$COMPOSED" = "$EXPECTED" ]; then
    ok "probe: cold /resume rejoined the recorded preset ($COMPOSED)"
  else
    bad "probe: cold /resume composed bare or wrong ('$COMPOSED' vs '$EXPECTED')"
  fi
else
  bad 'probe: resume leg produced no/failed result'
  cat "$WORK/probe-resume.json" 2>/dev/null | sed 's/^/    | /'
  grep -a "dsh-feishu:" "$WORK/probe-resume.log" 2>/dev/null | head -3 | sed 's/^/    | /'
  tail -8 "$WORK/probe-resume.log" 2>/dev/null | sed 's/^/    | /'
fi
pkill -f "dsh --profile e2e-probe" 2>/dev/null || true

# ------------------------------------------------------------------ summary --
printf '\n%d %d 0\n' "$PASS" "$FAIL" > "$WORK/e2e.result"
if [ "$FAIL" -gt 0 ]; then
  printf '==> web-profile compat e2e: %d pass, %d fail\n' "$PASS" "$FAIL"
  exit 1
fi
printf '==> web-profile compat e2e: %d pass, %d fail — OK\n' "$PASS" "$FAIL"
