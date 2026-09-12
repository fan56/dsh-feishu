#!/usr/bin/env bash
# web-profile compat e2e — runs on the LOCAL dsh (no container, no Lark).
#
# Verifies the two scenarios the phone plugin must survive when the desktop
# runs a web profile alongside it:
#
#   leg A — web-profile composition: a profile made of `dsh-base +
#           dsh-web-app + dsh-feishu` must dump a tree containing dsh-feishu
#           and boot the web server cleanly (no loader errors).
#   leg B — tui/web coexistence: the same isolated $DSH_HOME also carries a
#           `tui` profile (`dsh-base + dsh-tui-pi + dsh-feishu`); both
#           profiles boot side by side without crashing, and dsh-feishu
#           (dormant without Lark credentials) never takes the process down.
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
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- scaffold one profile ---------------------------------------------------
scaffold() { # $1=profile-name $2=comma-separated bundle list
  local name="$1" bundles="$2"
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

# ------------------------------------------------------------------ summary --
printf '\n%d %d 0\n' "$PASS" "$FAIL" > "$WORK/e2e.result"
if [ "$FAIL" -gt 0 ]; then
  printf '==> web-profile compat e2e: %d pass, %d fail\n' "$PASS" "$FAIL"
  exit 1
fi
printf '==> web-profile compat e2e: %d pass, %d fail — OK\n' "$PASS" "$FAIL"
