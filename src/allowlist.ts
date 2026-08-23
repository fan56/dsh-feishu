/**
 * Operator allowlist. The Feishu tenant's account system carries identity;
 * this gate is the authorization: every inbound message and (future) card
 * callback must pass `isOperator` before the bot acts on it. Non-operators are
 * ignored SILENTLY — no reply, no reaction — so the bot's existence leaks
 * nothing to strangers who find it.
 */

/** Normalize one candidate id: trim and drop empties. */
function normalize(id: string): string | undefined {
  const value = id.trim()
  return value === '' ? undefined : value
}

/**
 * Build the effective allowlist set from config + env. `DSH_FEISHU_OPERATORS`
 * (comma-separated open_ids) extends the config list — handy for quick local
 * tests without editing the patch file.
 */
export function buildAllowlist(configured: readonly string[], env = process.env): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const id of configured) {
    const value = normalize(id)
    if (value !== undefined) ids.add(value)
  }
  const fromEnv = env.DSH_FEISHU_OPERATORS
  if (fromEnv !== undefined && fromEnv !== '') {
    for (const id of fromEnv.split(',')) {
      const value = normalize(id)
      if (value !== undefined) ids.add(value)
    }
  }
  return ids
}

/**
 * Whether one sender open_id may operate the bot. An empty allowlist authorizes
 * NOBODY — the caller must treat that as "bot inert", not "bot open".
 */
export function isOperator(openId: string | undefined, allowlist: ReadonlySet<string>): boolean {
  if (openId === undefined || openId === '') return false
  return allowlist.has(openId)
}
