import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { apply, inject, name, stripFrontmatter } from '../lib/index.js'

// Minimal cordis-like context: the bundled-skill registration path needs
// ctx.skills; the default (empty) config leaves the bot dormant right after,
// so only the logger and the effect slot are touched beyond that.
function mockCtx() {
  const registered = []
  const ctx = {
    registered,
    logger: {
      error() {},
      warn() {},
      info() {},
      debug() {},
    },
    effect() {},
    inject() {},
    get() {
      return undefined
    },
    skills: {
      registerProvider(create) {
        const provider = create({
          signal: new AbortController().signal,
          invalidate() {},
        })
        registered.push(provider)
        return () => {}
      },
    },
  }
  return ctx
}

/** Extract one scalar value from the SKILL.md YAML frontmatter. */
function frontmatterValue(markdown, key) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, 'SKILL.md must open with a YAML frontmatter block')
  const line = match[1]
    .split('\n')
    .find((entry) => entry.startsWith(`${key}:`))
  assert.ok(line, `frontmatter must declare "${key}"`)
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/s, '$1')
}

test('plugin metadata: name and inject expose the skills dependency', () => {
  assert.equal(name, 'dsh-feishu')
  assert.ok(inject.includes('agents'), 'inject must keep the agents service')
  assert.ok(inject.includes('skills'), 'inject must declare the skills service')
})

test('apply registers the bundled skill provider on ctx.skills', async () => {
  const ctx = mockCtx()
  apply(ctx)
  assert.equal(ctx.registered.length, 1)
  const provider = ctx.registered[0]
  assert.equal(provider.name, 'dsh-feishu-config')

  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'dsh-feishu-config')
  assert.equal(candidate.provider, 'dsh-feishu-config')
  assert.equal(candidate.source, 'bundled')
  assert.equal(typeof candidate.rank, 'number')
  assert.ok(Number.isFinite(candidate.rank))
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(candidate.description.length > 0)
  assert.ok(candidate.description.length <= 500, 'description must stay within the 500-char routing budget')
  // The directory resource base must point at the packaged skills/ directory
  // (fileURLToPath keeps the trailing slash of the URL path).
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(
    candidate.resourceBase.path.replace(/\/$/, '').endsWith('skills/dsh-feishu-config'),
    `unexpected resourceBase path: ${candidate.resourceBase.path}`,
  )
})

test('provider.get loads the packaged SKILL.md with matching metadata', async () => {
  const ctx = mockCtx()
  apply(ctx)
  const provider = ctx.registered[0]
  const [candidate] = await provider.list({})

  const definition = await provider.get(candidate, {})
  assert.equal(definition.name, 'dsh-feishu-config')
  assert.equal(definition.description, candidate.description)
  // SkillDefinition.content is the instruction body after metadata removal:
  // the bundled get() must strip the raw frontmatter the file keeps for the
  // GitHub/manual install paths (same shape the filesystem provider serves).
  assert.ok(!definition.content.startsWith('---'), 'get() must not serve the frontmatter block')
  assert.ok(definition.content.includes('# dsh-feishu 使用指南'), 'body must be the packaged skill markdown')

  // Anti-drift: the hardcoded routing description must equal the SKILL.md
  // frontmatter, and the frontmatter itself must satisfy the registry grammar.
  const markdown = await readFile(new URL('../skills/dsh-feishu-config/SKILL.md', import.meta.url), 'utf8')
  assert.equal(frontmatterValue(markdown, 'name'), 'dsh-feishu-config')
  assert.equal(frontmatterValue(markdown, 'description'), candidate.description)
})

// Anti-drift guards: the onboarding rewrite must keep these key facts in the
// SKILL.md body (frontmatter is stripped so the description cannot satisfy
// them by accident). If one of these fails, a rewrite dropped a load-bearing
// fact — restore it instead of deleting the assertion.
test('SKILL.md body keeps the onboarding key-fact anchors', async () => {
  const markdown = await readFile(new URL('../skills/dsh-feishu-config/SKILL.md', import.meta.url), 'utf8')
  const body = stripFrontmatter(markdown)
  assert.match(body, /\/feishu-onboard/, 'desktop one-shot onboarding command')
  assert.match(body, /pairedOperators/, 'runtime pairing admin list in settings.yaml')
  assert.match(body, /card\.action\.trigger/, 'card callback subscription')
  assert.match(body, /长连接/, 'WebSocket long-connection event subscription mode')
  assert.match(body, /版本管理与发布/, 'version publishing step (most common blocker)')
  assert.match(body, /11205|机器人能力/, 'bot-capability error code handled by /feishu-onboard')
  assert.match(body, /im\.message\.receive_v1/, 'message-received event subscription')
  assert.match(body, /DSH_FEISHU_OPERATORS/, 'operators env override actually read at runtime')
})

test('stripFrontmatter tolerates missing or unclosed frontmatter', () => {
  // No frontmatter: returned unchanged.
  assert.equal(stripFrontmatter('plain body\n'), 'plain body\n')
  assert.equal(stripFrontmatter(''), '')
  // A `---` fence that never closes is not frontmatter: returned unchanged.
  assert.equal(stripFrontmatter('---\nname: x'), '---\nname: x')
  assert.equal(stripFrontmatter('---'), '---')
  // A closed block is stripped down to the trimmed instruction body.
  assert.equal(stripFrontmatter('---\nname: x\n---\n\n# Body\n'), '# Body')
  // CRLF line endings are tolerated on both fence lines.
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\n\r\n# Body\r\n'), '# Body')
})
