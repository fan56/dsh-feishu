/**
 * Session binder — the "attach, never create" core (design §2 定稿).
 *
 * Binding an existing session has two arms:
 *  1. ATTACH: the session already has a live agent in this process (the TUI
 *     is driving it, or a previous bot resume is alive) — `ctx.agents.get()`
 *     hands back the SAME Agent reference; followups land in that agent's
 *     inbox. The bot does NOT own this agent and never disposes it.
 *  2. RESUME: not live — `ctx.agents.resume({ resumeSessionId })` loads the
 *     persisted session; the bot OWNS that handle.
 *
 * Owned handles are never DISPOSED on rebind/detach: in the multi-surface
 * world another surface may have adopted the live agent (the TUI attaching
 * to a bot-created session), and disposing would kill it mid-flight.
 * Created/resumed agents stay live in the registry until the process ends.
 *
 * `agents.create` is called from exactly one place — the operator's explicit
 * /new (never implicitly mid-flow), so the bot cannot mint surprise sessions.
 * Resuming an already-live session is equally forbidden (the registry would
 * race the live agent) — the attach arm covers that case.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionLogRoot } from './resume-table.ts'
import { RemoteSessionTail } from './remote-tail.ts'
import { WriterLockedError, acquireWriterLock, projectKeyFor, releaseOwnedWriterLock, type WriterLockHolder } from './writer-lock.ts'

/** How the current binding came to be. */
export type BindMode = 'attached' | 'resumed' | 'created'

/**
 * The header-shaped metadata needed to locate a session's storage directory
 * (the jsonl backend only reads `id` and `cwd` out of it).
 */
interface HeaderLike {
  id: unknown
  cwd?: string | undefined
}

/** The persistence surface this module needs (structural). */
interface PersistenceSeam {
  list(signal?: AbortSignal): Promise<HeaderLike[]>
}


/** Result of a successful bind. */
export interface BindResult {
  readonly sessionId: string
  readonly mode: BindMode
  readonly agent: Agent
  /** Created sessions only: the bot-owned selection ref (/model live-switch). */
  readonly selectionRef?: ModelSelectionRef
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
  /** Kept for the persistence seam that resolves header metadata. */
  private readonly ctx: Context
  /** Decoder/interval seam for the read-only remote view (tests inject). */
  private readonly viewerOptions: { intervalMs?: number; decode?(file: string): Promise<string> }
  /** Active read-only view (another process drives the session). */
  private remoteTail: RemoteSessionTail | undefined
  /**
   * Session dirs whose cross-process writer lock WE hold. Deliberately not
   * cleared on rebind/detach: the agent stays live (adoptable) in this
   * process's registry, so dropping the lock would reopen the exact
   * two-process race the guard kills.
   *
   * Lifecycle caveat: locks flush at binder.dispose(). That is correct for
   * process teardown, but NOT for "plugin fiber disposed while the dsh
   * process keeps running" (e.g. a plugin-only reload that leaves created/
   * resumed agents live in the registry) — during such a window the session
   * is live here yet unlocked, and another process may cold-resume it.
   * Accepted until lock lifecycle can ride agent lifetime instead of binder
   * lifetime; never dispose this binder without the whole plugin/process.
   */
  private readonly heldLockDirs = new Set<string>()

  constructor(ctx: Context, options: { viewerOptions?: { intervalMs?: number; decode?(file: string): Promise<string> } } = {}) {
    this.ctx = ctx
    this.viewerOptions = options.viewerOptions ?? {}
    // ctx.agents is injected (plugin `inject`); the structural cast keeps
    // this module free of the full registry type.
    this.agents = (ctx as Context & { agents: AgentsRegistry }).agents
  }

  /** While a remote watch is active, the phone is a viewer, not a driver. */
  isReadOnlyView(): boolean {
    return this.remoteTail !== undefined
  }

  /**
   * READ-ONLY cross-process view: another dsh process drives this session
   * (the writer guard refused our cold resume), so sync the phone's cards
   * from its persisted log instead. Durable rows only — every turn's final
   * assistant message arrives (poll-delayed, streaming detail omitted).
   */
  async watchRemote(
    sessionId: string,
    onEvents: (events: Array<Record<string, unknown>>) => void,
  ): Promise<void> {
    await this.stopWatchRemote()
    const cwd = await this.headerCwdOf(sessionId)
    if (cwd === undefined) throw new Error(`cannot locate the log of ${sessionId} for read-only viewing`)
    this.sessionId = sessionId
    const file = join(sessionLogRoot(), projectKeyFor(cwd), sessionId, 'session.jsonl.zstd')
    const tail = new RemoteSessionTail(file, {
      onEvents: list => {
        if (this.remoteTail !== tail) return
        onEvents(list as unknown as Array<Record<string, unknown>>)
      },
    }, this.viewerOptions)
    this.remoteTail = tail
    await tail.tickOnce() // deterministic backfill of stored history
    tail.start()
  }

  private async stopWatchRemote(): Promise<void> {
    if (this.remoteTail === undefined) return
    this.remoteTail.stop()
    this.remoteTail = undefined
  }

  /** Historical cwd for a session from persisted headers — best-effort. */
  private async headerCwdOf(sessionId: string): Promise<string | undefined> {
    try {
      const persistence = this.ctx.get('sessionPersistence') as PersistenceSeam | undefined
      const stored = (await persistence?.list().catch(() => [])) ?? []
      const header = stored.find(candidate => String(candidate.id) === sessionId)
      return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
    } catch {
      return undefined
    }
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
    const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
    // Single-writer guard BEFORE agents.create: minting the UUID here (not
    // inside agents.create) lets the header handed to the locator carry the
    // exact id + cwd that create is about to persist (locate reads only
    // those), making the pre-create acquisition race-free by construction.
    const sessionId = crypto.randomUUID()
    const restore = await this.acquireLockGuard({ id: sessionId, cwd })
    try {
      const handle = await this.agents.create({
        sessionId: SessionId(sessionId),
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
      // The created session's model selection is bot-owned — handing the ref
      // back lets the bot live-switch the route later (/model).
      return { sessionId: this.sessionId, mode: 'created', agent: handle.agent, selectionRef }
    } catch (error) {
      // Nothing was bound — do not keep a guard for a session we never made.
      await this.discardAcquiredLock(restore)
      throw error
    }
  }

  /** Bind one session id (attach when live, else resume). */
  async bind(id: string, agentOptions?: { provider?: string; model?: string }): Promise<BindResult> {
    if (this.binding !== undefined) await this.binding.catch(() => undefined)
    const task = this.bindInner(id, agentOptions)
    this.binding = task
    try {
      return await task
    } finally {
      this.binding = undefined
    }
  }

  private async bindInner(id: string, agentOptions?: { provider?: string; model?: string }): Promise<BindResult> {
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
    // A cold resume with no agentOptions can revive a route-less agent
    // (sessions created before the route fix have no request/header in
    // their log) — the caller resolves the route, we pass it through.
    // Single-writer guard FIRST: a registry miss does not mean the session
    // is free — another process may be driving it right now, and resuming
    // here would fork the log (interleaved seq numbers). Refuse loudly
    // instead; adopt/attach flows above intentionally touch no lock.
    const restore = await this.acquireLockGuard({ id })
    try {
      const handle = await this.agents.resume({
        resumeSessionId: SessionId(id),
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      })
      // No dispose of `previous` (same multi-surface rule as releaseOwned):
      // the old agent stays live and adoptable by other surfaces.
      this.owned = handle
      this.sessionId = id
      return { sessionId: id, mode: 'resumed', agent: handle.agent }
    } catch (error) {
      // The resume failed — release just THIS acquisition so a transient
      // failure cannot pin the session for the remaining process lifetime.
      // Longer-held guards (previous bindings) are untouched here.
      await this.discardAcquiredLock(restore)
      throw error
    }
  }

  /**
   * Resolve the directory the jsonl backend owns for a session
   * (`<sessionRoot>/<projectKey(cwd)>/<id>`) and acquire its cross-process
   * writer lock. The lock must sit beside the persisted log so every process
   * that could write that log competes on the same file. Without a known cwd
   * (caller gave none, none persisted) the derivation would produce a decoy
   * path the real writer never touches — skip rather than guard nothing
   * (fail-open; the underlying resume/create would proceed unprotected,
   * exactly as before this guard existed).
   */
  private async acquireLockGuard(meta: HeaderLike): Promise<{ dir: string } | undefined> {
    const id = String(meta.id)
    let cwd = typeof meta.cwd === 'string' && meta.cwd !== '' ? meta.cwd : undefined
    if (cwd === undefined) {
      // Best-effort by design: no trustworthy cwd → unguarded skip (fail-open),
      // never lock a decoy path.
      cwd = await this.headerCwdOf(id).catch(() => undefined)
    }
    if (cwd === undefined) return undefined

    const dir = join(sessionLogRoot(), projectKeyFor(cwd), id)
    const result = await acquireWriterLock(dir)
    if (!result.ok) throw new WriterLockedError(result.holder)
    this.heldLockDirs.add(dir)
    return { dir }
  }

  /** Undo one guard that did NOT end up owning a binding. */
  private async discardAcquiredLock(guard: { dir: string } | undefined): Promise<void> {
    if (guard === undefined) return
    this.heldLockDirs.delete(guard.dir)
    await releaseOwnedWriterLock(guard.dir)
  }

  /** Drop the binding (detach). Only OUR handle is disposed — never an attached one. */
  async detach(): Promise<void> {
    await this.stopWatchRemote()
    this.sessionId = undefined
    await this.releaseOwned()
  }

  private async releaseOwned(): Promise<void> {
    // Deliberately NO dispose: in the multi-surface world an owned handle
    // may already have been ADOPTED by another surface (the TUI attaching
    // to a bot-created session) — disposing here would kill the agent out
    // from under it (live: the attach succeeded, then every message failed
    // because the returned agent had just been disposed). Surfaces attach
    // and detach freely; created/resumed agents simply stay live in the
    // registry until the process ends.
    this.owned = undefined
  }

  /** Dispose everything we own (plugin teardown). */
  async dispose(): Promise<void> {
    await this.stopWatchRemote()
    await this.detach()
    // Plugin teardown: release every writer lock this binder ESTABLISHED.
    // Locks intentionally survive detach/rebind while their agent stays live
    // in this process's registry (see heldLockDirs) — only shutdown drops them.
    for (const dir of [...this.heldLockDirs]) {
      this.heldLockDirs.delete(dir)
      await releaseOwnedWriterLock(dir)
    }
  }
}
