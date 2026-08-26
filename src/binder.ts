/**
 * Session binder — the "attach, never create" core (design §2 定稿).
 *
 * Binding an existing session has two arms:
 *  1. ATTACH: the session already has a live agent in this process (the TUI
 *     is driving it, or a previous bot resume is alive) — `ctx.agents.get()`
 *     hands back the SAME Agent reference; followups land in that agent's
 *     inbox. The bot does NOT own this agent and never disposes it.
 *  2. RESUME: not live — `ctx.agents.resume({ resumeSessionId })` loads the
 *     persisted session; the bot OWNS that handle and disposes it on
 *     rebind/detach.
 *
 * `agents.create` is called from exactly one place — the operator's explicit
 * /new (never implicitly mid-flow), so the bot cannot mint surprise sessions.
 * Resuming an already-live session is equally forbidden (the registry would
 * race the live agent) — the attach arm covers that case.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** How the current binding came to be. */
export type BindMode = 'attached' | 'resumed' | 'created'

/** Result of a successful bind. */
export interface BindResult {
  readonly sessionId: string
  readonly mode: BindMode
  readonly agent: Agent
}

/** Minimal registry surface (structural — matches ctx.agents). */
interface AgentsRegistry {
  get(id: SessionId): Agent | undefined
  resume(options: { resumeSessionId: SessionId }): Promise<AgentHandle>
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: Context) => unknown
  }): Promise<AgentHandle>
}

/**
 * One-bound-session-at-a-time binder. Concurrent binds serialize on the
 * in-flight task so `/resume 3` racing `/resume 5` cannot leak handles.
 */
export class SessionBinder {
  private readonly agents: AgentsRegistry
  /** Handle we own (from our own resume); disposed on rebind/detach. */
  private owned: AgentHandle | undefined
  /** Session id of the current binding (live or ours). */
  private sessionId: string | undefined
  private binding: Promise<BindResult> | undefined

  constructor(ctx: Context) {
    // ctx.agents is injected (plugin `inject`); the structural cast keeps
    // this module free of the full registry type.
    this.agents = (ctx as Context & { agents: AgentsRegistry }).agents
  }

  /** The bound session id, when bound. */
  getSessionId(): string | undefined {
    return this.sessionId
  }

  /** Live agent for an arbitrary session id, when one exists (no binding change). */
  getAgentFor(id: string): Agent | undefined {
    return this.agents.get(SessionId(id))
  }

  /**
   * The bound live agent. Re-probes the registry when our cached reference
   * went away (the TUI resumed the same id into its own handle) — an attach
   * must always route followups to whoever is live NOW.
   */
  getAgent(): Agent | undefined {
    const id = this.sessionId
    if (id === undefined) return undefined
    const live = this.agents.get(SessionId(id))
    if (live !== undefined) return live
    return this.owned?.agent
  }

  /**
   * Create a FRESH root session and bind to it — the explicit /new flow.
   * The "never create" invariant now means "never create IMPLICITLY": this
   * is the operator's deliberate action, same right the TUI/web surfaces
   * have. We own the resulting handle exactly like the resume arm.
   */
  /**
   * Create a fresh agent bound to the given model selection. The selection
   * goes in twice: agentOptions covers the pre-setup surface, and a setup
   * hook couples it into the agent's request waterfall via
   * installModelSelection — agentOptions alone cannot carry a reasoning
   * effort, and effort-less requests die on endpoints that mandate
   * reasoning (400 "Reasoning is mandatory", ox-alpha in live use).
   */
  async createNew(cwd: string, selection?: ModelSelection): Promise<BindResult> {
    if (this.binding !== undefined) await this.binding.catch(() => undefined)
    const task = this.createNewInner(cwd, selection)
    this.binding = task
    try {
      return await task
    } finally {
      this.binding = undefined
    }
  }

  private async createNewInner(cwd: string, selection?: ModelSelection): Promise<BindResult> {
    await this.releaseOwned()
    const selectionRef = { current: selection, assembled: undefined }
    const handle = await this.agents.create({
      sessionId: SessionId(crypto.randomUUID()),
      meta: { cwd },
      // A bare create has NO route — the first request dies with "agent has
      // no provider/model" (the TUI composes its default selection before
      // creating; the bot inherits the previous session's route instead).
      ...(selection !== undefined ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
      setup: agentCtx => {
        installModelSelection(agentCtx, selectionRef)
      },
    })
    this.owned = handle
    this.sessionId = String(handle.agent.session.id)
    return { sessionId: this.sessionId, mode: 'created', agent: handle.agent }
  }

  /** Bind one session id (attach when live, else resume). */
  async bind(id: string): Promise<BindResult> {
    if (this.binding !== undefined) await this.binding.catch(() => undefined)
    const task = this.bindInner(id)
    this.binding = task
    try {
      return await task
    } finally {
      this.binding = undefined
    }
  }

  private async bindInner(id: string): Promise<BindResult> {
    const live = this.agents.get(SessionId(id))
    if (live !== undefined) {
      if (this.owned !== undefined && this.owned.agent === live) {
        // The live agent IS our own resumed handle — keep ownership as is.
        this.sessionId = id
        return { sessionId: id, mode: 'resumed', agent: live }
      }
      // Someone else owns the live agent — release any handle of OURS (for
      // another session, or a stale duplicate) and attach to theirs.
      await this.releaseOwned()
      this.sessionId = id
      return { sessionId: id, mode: 'attached', agent: live }
    }
    // Resume arm: load the persisted session; we own the handle.
    const previous = this.owned
    if (previous !== undefined && String(previous.agent.session.id) === id) {
      // Already our own binding.
      this.sessionId = id
      return { sessionId: id, mode: 'resumed', agent: previous.agent }
    }
    const handle = await this.agents.resume({ resumeSessionId: SessionId(id) })
    if (previous !== undefined) await previous.dispose().catch(() => undefined)
    this.owned = handle
    this.sessionId = id
    return { sessionId: id, mode: 'resumed', agent: handle.agent }
  }

  /** Drop the binding (detach). Only OUR handle is disposed — never an attached one. */
  async detach(): Promise<void> {
    this.sessionId = undefined
    await this.releaseOwned()
  }

  private async releaseOwned(): Promise<void> {
    const owned = this.owned
    this.owned = undefined
    if (owned !== undefined) await owned.dispose().catch(() => undefined)
  }

  /** Dispose everything we own (plugin teardown). */
  async dispose(): Promise<void> {
    await this.detach()
  }
}
