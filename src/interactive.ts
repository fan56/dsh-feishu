/**
 * Interactive command adapters — the selector-FW consumers. Each adapter
 * renders one desktop picker through the generic selection card and applies
 * the picked option through an existing channel:
 *
 * - /think — reasoning-effort picker for the bound session's current model
 *   (`llm.resolveModelInfo(...).reasoning.efforts`, same source the TUI's
 *   effort picker uses); applies via the shared model-selection core;
 * - /permission — permission-preset picker (`ctx.get('permissionPresets')`);
 *   the pick is REPLAYED through the canonical `/permission <name>` command
 *   execution, the same path the desktop TUI uses for its picker;
 * - /select-skill — user-invocable skill picker (`ctx.get('skills').list`);
 *   activation rides the harness's OWN `/name` skill gesture — the picked
 *   name is injected as a plain user message through the steer/followup
 *   channel, which tool-skill scans for gestures (never a bespoke API call);
 * - /profile-switch — model-profile switcher over `$DSH_HOME/model-profiles.json`
 *   (same schema the TUI owns); applies the profile's route via the shared
 *   model-selection core. Desktop-only side effects (agent frontmatter
 *   writes, `current` persistence) are deliberately NOT replicated.
 *
 * Every adapter owns its degraded replies (missing service, unbound session,
 * unknown model) so the dispatch loop never sees a throw.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { clipLine } from './text.ts'
import type { SelectorOutcome } from './selector.ts'
import type { SelectorSpec } from './selector-card.ts'
import type { SessionBinder } from './binder.ts'
import type { StateStore } from './state-store.ts'

/** A model selection handed to the shared apply core (effort optional). */
export interface ModelSelectionUpdate {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Best-effort current model selection of the bound session. */
export interface CurrentSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * The bot-side surfaces the adapters drive. Implemented by FeishuBot — the
 * shared apply core, the prompt-injection channel and the current-selection
 * chain stay bot-owned so /model and these adapters cannot drift apart.
 */
export interface InteractiveHost {
  readonly ctx: Context
  readonly store: StateStore
  readonly binder: SessionBinder
  /** Reply with a body card in the operator's last chat. */
  reply(text: string): Promise<void>
  /** Present a selection card; resolves with the operator's outcome. */
  presentSelection(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome>
  /** Shared model-selection apply (live ref vs phone default). */
  applyModelSelection(selection: ModelSelectionUpdate): Promise<'live' | 'phone-default'>
  /**
   * Inject text as a plain user message (steer when running, followup when
   * idle). 'refused' = read-only view or no bound session.
   */
  injectPrompt(text: string): Promise<'steered' | 'opened' | 'refused'>
  /** Execute a dsh command line through the command registry (replies itself). */
  executeCommand(name: string, line: string): Promise<void>
  /** Current model selection of the bound session (best-effort chain). */
  currentSelection(): Promise<CurrentSelection | undefined>
  /** The bound live agent (resuming when needed); undefined when unbound. */
  boundAgent(): Promise<Agent | undefined>
}

/** The llm surface /think needs (structural view of ctx.get('llm')). */
interface LlmReasoningSurface {
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts?: readonly { id: string; name: string; description?: string }[] }
  }>
}

/** The permission-presets surface /permission needs (structural view). */
interface PermissionPresetsLike {
  readonly names: readonly string[]
  optionOf(name: string): { value: string; name: string; description?: string }
}

/** The skills surface /select-skill needs (structural view). */
interface SkillsServiceLike {
  list(options: { scope?: unknown; cwd?: string }): Promise<readonly {
    name: string
    description?: string
    invocation?: { userInvocable?: boolean }
  }[]>
}

/** Reply text for a missing binding — same wording as the other commands. */
const UNBOUND_REPLY = '尚未绑定会话。先发 /resume 进入一个会话。'

/** Option value that explicitly clears the effort override (TUI's default row). */
const DEFAULT_EFFORT = 'default'

// ---------------------------------------------------------------- /think --

/**
 * /think — pick a reasoning effort for the bound session's CURRENT model.
 * Efforts come from the model adapter (`resolveModelInfo`), matching the
 * TUI's effort picker; an unknown route asks for /model first.
 */
export async function runThinkCommand(host: InteractiveHost): Promise<void> {
  const chatId = host.store.get().lastChatId
  if (chatId === undefined) return
  if ((host.binder.getSessionId() ?? host.store.get().boundSessionId) === undefined) {
    await host.reply(UNBOUND_REPLY)
    return
  }
  const current = await host.currentSelection()
  if (current === undefined) {
    await host.reply('当前会话没有已知的模型选择，先用 /model 选择模型。')
    return
  }
  const llm = host.ctx.get('llm') as LlmReasoningSurface | undefined
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    await host.reply('当前 profile 没有 llm 服务，无法列出推理档位。')
    return
  }
  let efforts: readonly { id: string; name: string; description?: string }[] | undefined
  try {
    efforts = (await llm.resolveModelInfo(current.provider, current.model)).reasoning?.efforts
  } catch {
    efforts = undefined // resolution failure = no selectable efforts
  }
  if (efforts === undefined || efforts.length === 0) {
    await host.reply(`模型 ${current.provider} / ${current.model} 没有可选的推理档位。`)
    return
  }
  const route = `${current.provider} / ${current.model}${current.reasoningEffort === undefined ? '' : ` · 当前 ${current.reasoningEffort}`}`
  const outcome = await host.presentSelection(chatId, {
    title: '思考档位',
    description: route,
    mode: 'buttons',
    options: [
      { value: DEFAULT_EFFORT, label: '默认', description: '清除档位覆盖，跟随 provider 默认' },
      ...efforts.map(effort => ({
        value: effort.id,
        label: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
    ],
  })
  if (outcome.status !== 'picked') return
  const effort = outcome.value === DEFAULT_EFFORT ? undefined : outcome.value
  const target = await host.applyModelSelection({
    provider: current.provider,
    model: current.model,
    reasoningEffort: effort,
  })
  await host.reply(target === 'live'
    ? `✅ 思考档位：${outcome.label}（${route}）`
    : `已存为手机默认（思考档位 ${outcome.label}）；当前会话由桌面驱动，请在电脑端调整。`)
}

// ----------------------------------------------------------- /permission --

/**
 * /permission — pick a permission preset and replay it through the canonical
 * `/permission <name>` command execution (the registry owns the switch, so
 * sandbox/approval knobs ride the same path as the desktop picker).
 */
export async function runPermissionCommand(host: InteractiveHost): Promise<void> {
  const chatId = host.store.get().lastChatId
  if (chatId === undefined) return
  if ((host.binder.getSessionId() ?? host.store.get().boundSessionId) === undefined) {
    await host.reply(UNBOUND_REPLY)
    return
  }
  const presets = host.ctx.get('permissionPresets') as PermissionPresetsLike | undefined
  if (presets === undefined || !Array.isArray(presets.names)) {
    await host.reply('当前 profile 没有权限 preset 服务。')
    return
  }
  const options = presets.names.map(name => {
    const option = presets.optionOf(name)
    return {
      value: option.value,
      label: option.name,
      ...(option.description === undefined ? {} : { description: option.description }),
    }
  })
  if (options.length === 0) {
    await host.reply('没有可用的权限 preset。')
    return
  }
  const outcome = await host.presentSelection(chatId, { title: '权限 Preset', mode: 'buttons', options })
  if (outcome.status !== 'picked') return
  // Replay through the command registry — never a bespoke preset API.
  await host.executeCommand('permission', `/permission ${outcome.value}`)
}

// -------------------------------------------------------- /select-skill --

/** select_static option cap — past it the card truncates (selector FW). */
const SKILL_OPTION_CAP = 50

/**
 * /select-skill — pick a user-invocable skill and activate it by injecting
 * the harness's own `/name` skill gesture as a plain user message. This is
 * the official activation path: tool-skill scans direct user input for the
 * gesture and injects the rendered skill content itself.
 */
export async function runSelectSkillCommand(host: InteractiveHost): Promise<void> {
  const chatId = host.store.get().lastChatId
  if (chatId === undefined) return
  const agent = await host.boundAgent()
  if (agent === undefined) {
    await host.reply(UNBOUND_REPLY)
    return
  }
  const skills = host.ctx.get('skills') as SkillsServiceLike | undefined
  if (skills === undefined || typeof skills.list !== 'function') {
    await host.reply('当前 profile 没有 skills 服务。')
    return
  }
  // Same workspace source as the TUI's skill list: the session header's cwd,
  // process cwd as the fallback.
  const header = (agent as { session?: { header?: { cwd?: unknown } } }).session?.header
  const headerCwd = header?.cwd
  const cwd = typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : process.cwd()
  let summaries: Awaited<ReturnType<SkillsServiceLike['list']>>
  try {
    summaries = await skills.list({ scope: agent, cwd })
  } catch (error) {
    const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
    await host.reply(`读取技能列表失败：${reason === '' ? '未知错误' : reason}`)
    return
  }
  // User-invocable only — same policy as the desktop's user-facing command
  // catalogs (the registry's isUserInvocable; read off the invocation field
  // to keep this module free of a runtime skill-registry dependency).
  const invocable = summaries
    .filter(skill => skill.invocation?.userInvocable === true)
    .sort((a, b) => a.name.localeCompare(b.name))
  if (invocable.length === 0) {
    await host.reply('当前工作区没有可供调用的技能。')
    return
  }
  const truncated = invocable.length > SKILL_OPTION_CAP
  const outcome = await host.presentSelection(chatId, {
    title: '选择技能',
    description: truncated ? `共 ${invocable.length} 个技能，仅显示前 ${SKILL_OPTION_CAP} 个。` : undefined,
    mode: 'select',
    submitLabel: '激活',
    options: invocable.slice(0, SKILL_OPTION_CAP).map(skill => ({
      value: skill.name,
      label: `/${skill.name}`,
      ...(skill.description === undefined ? {} : { description: skill.description }),
    })),
  })
  if (outcome.status !== 'picked') return
  // The gesture must arrive as a plain user message — the injection channel
  // does exactly that (and is NOT routed through classifyInbound, so the
  // leading slash is never mistaken for a bot command).
  const injected = await host.injectPrompt(`/${outcome.value}`)
  if (injected === 'refused') {
    await host.reply(host.binder.isReadOnlyView()
      ? '当前为只读旁观（该会话正由另一进程驱动），无法激活技能。'
      : UNBOUND_REPLY)
    return
  }
  await host.reply(`✅ 已注入技能 /${outcome.value}`)
}

// ------------------------------------------------------ /profile-switch --

/** The profile's default model route (subset of the TUI's on-disk schema). */
export interface ProfileRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One named profile (only the fields the switcher reads). */
export interface ModelProfileEntry {
  readonly name: string
  readonly defaultModel?: ProfileRoute
}

/** The stored document (subset of the TUI's on-disk schema, version 1). */
export interface ModelProfilesDoc {
  readonly current?: string
  readonly profiles: readonly ModelProfileEntry[]
}

/** `$DSH_HOME/model-profiles.json` — same store the TUI owns. */
export function modelProfilesPath(home: string = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(home, 'model-profiles.json')
}

/** Narrow an unknown JSON value into a route; anything else drops it. */
function narrowRoute(value: unknown): ProfileRoute | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { provider, model, reasoningEffort } = value as Record<string, unknown>
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
  }
}

/**
 * Read + validate `$DSH_HOME/model-profiles.json` (version 1, same schema the
 * TUI owns). Returns undefined when the file is missing, unreadable or
 * corrupt — the adapter answers with a pointer instead of guessing.
 */
export async function loadModelProfilesDoc(path: string): Promise<ModelProfilesDoc | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) return undefined
  const profiles: ModelProfileEntry[] = []
  if (Array.isArray(doc.profiles)) {
    for (const value of doc.profiles) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const { name, defaultModel } = value as Record<string, unknown>
      if (typeof name !== 'string' || name.trim() === '') continue
      const route = narrowRoute(defaultModel)
      profiles.push({ name: name.trim(), ...(route === undefined ? {} : { defaultModel: route }) })
    }
  }
  return {
    ...(typeof doc.current === 'string' && doc.current !== '' ? { current: doc.current } : {}),
    profiles,
  }
}

/**
 * /profile-switch — pick one of the stored model profiles and apply its
 * route (provider/model/effort) through the shared model-selection core.
 */
export async function runProfileSwitchCommand(host: InteractiveHost, path: string = modelProfilesPath()): Promise<void> {
  const chatId = host.store.get().lastChatId
  if (chatId === undefined) return
  if ((host.binder.getSessionId() ?? host.store.get().boundSessionId) === undefined) {
    await host.reply(UNBOUND_REPLY)
    return
  }
  const doc = await loadModelProfilesDoc(path)
  if (doc === undefined) {
    await host.reply('模型 profile 文件不存在或不可读（$DSH_HOME/model-profiles.json）。')
    return
  }
  // Only profiles with a default route can be applied here — an empty
  // profile has no provider/model to switch to.
  const options = doc.profiles
    .filter(profile => profile.defaultModel !== undefined)
    .map(profile => {
      const route = profile.defaultModel!
      return {
        value: profile.name,
        label: profile.name,
        description: `${route.provider} / ${route.model}${route.reasoningEffort === undefined ? '' : ` · effort ${route.reasoningEffort}`}`,
      }
    })
  if (options.length === 0) {
    await host.reply('profile 都没有配置默认模型，无可切换项（可在电脑端 /profile-cfg 配置）。')
    return
  }
  const outcome = await host.presentSelection(chatId, {
    title: '切换模型 Profile',
    ...(doc.current === undefined ? {} : { description: `当前：${doc.current}` }),
    mode: 'select',
    options,
  })
  if (outcome.status !== 'picked') return
  const picked = doc.profiles.find(profile => profile.name === outcome.value)
  const route = picked?.defaultModel
  if (picked === undefined || route === undefined) return
  const target = await host.applyModelSelection(route)
  await host.reply(target === 'live'
    ? `✅ 已应用 profile「${outcome.value}」：${route.provider} / ${route.model}${route.reasoningEffort === undefined ? '' : ` · ${route.reasoningEffort}`}`
    : `已存为手机默认（profile「${outcome.value}」）；当前会话由桌面驱动，请在电脑端切换。`)
}
