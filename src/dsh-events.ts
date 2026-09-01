/**
 * Local structural types for session events whose declaring packages are not
 * part of the core `SessionEventMap`. The firehose delivers them regardless
 * (it is not scope-filtered — dsh-tui-pi folds them the same way), so this
 * module merges the foreign event types into the map via module augmentation
 * and narrows them with structural reads.
 *
 * `todo/write` moved OUT of dsh-session in dsh 0.1.2-alpha.3 — its
 * SessionEventMap entry now lives in @deepseek-ai/dsh-tool-todo, pulled in
 * by the type-only side-effect import below (erased at emit; the closure
 * linker provides the types, the host ships the code).
 */

import type {} from '@deepseek-ai/dsh-tool-todo'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    'subagent/descriptor': SubagentDescriptorData
    'llm/retry': LlmRetryData
  }
}

/** `tool-workflow/agent-start`: one workflow member, after its child Session is published. */
export interface ToolWorkflowAgentStartData {
  readonly runId: string
  readonly seq: number
  readonly label: string
  readonly childId: string
}

/** `tool-workflow/agent-end`: one workflow member settlement. */
export interface ToolWorkflowAgentEndData {
  readonly runId: string
  readonly seq: number
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}

/** `subagent/descriptor`: durable identity of a session-backed subagent child. */
export interface SubagentDescriptorData {
  readonly version: number
  readonly mode: 'one-shot' | 'continuable'
  readonly provider: string
  readonly label?: string
}

/** `llm/retry`: one provider-routed retry scheduled after a failed request attempt. */
export interface LlmRetryData {
  readonly retry: number
  readonly maxRetries?: number
}

export type { SessionEvent }
