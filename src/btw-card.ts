/**
 * btw card builders — project the pure {@link BtwRunState} into Feishu
 * schema-2.0 cards (same JSON family as the round/ask/model cards). One live
 * card per btw run: opened when the run starts, patched on the 5s beat while
 * streaming (pseudo-streaming, hash-free — the answer tail grows almost
 * every beat), settled in place when the run finishes. Bare `/btw` review
 * re-ships the settled shape as a fresh card.
 *
 * Pure JSON in / JSON out — no Lark calls, unit-testable (test/btw-card.test.mjs).
 */

import { clipLine } from './text.ts'
import type { BtwRunState } from './btw.ts'

/** Answer chars shown before the tail window kicks in (card body budget). */
const BTW_ANSWER_CHAR_BUDGET = 1200

/** Feishu card JSON schema 2.0 (mirrors card.ts's shape). */
export interface BtwSchema2Card {
  schema: '2.0'
  config: { width_mode: string }
  header?: {
    title: { tag: 'plain_text'; content: string }
    subtitle?: { tag: 'plain_text'; content: string }
    template: 'blue' | 'green' | 'red' | 'grey' | 'orange'
  }
  body: { elements: Array<Record<string, unknown>> }
}

const FOOTER_NOTE = '不进会话记录 · 空参 /btw 回看上一条'

/** Last answer chars that fit the card; the hidden prefix is named. */
export function btwAnswerTail(answer: string): string {
  if (answer.length <= BTW_ANSWER_CHAR_BUDGET) return answer
  const hidden = answer.length - BTW_ANSWER_CHAR_BUDGET
  return `…（前文 ${hidden} 字）\n${answer.slice(-BTW_ANSWER_CHAR_BUDGET)}`
}

/** Quote-fold the question so multi-line input stays inside one blockquote. */
function questionQuote(question: string): string {
  return question
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
}

/**
 * The one card for every run state: header template carries the outcome
 * (streaming blue → done green / error red / canceled grey); the body is
 * question quote + answer tail (or status line) + the footer note.
 */
export function buildBtwCard(run: BtwRunState, queuedCount: number): BtwSchema2Card {
  const queuedSuffix = queuedCount > 0 ? ` · 排队 ${queuedCount}` : ''
  let template: 'blue' | 'green' | 'red' | 'grey' | 'orange'
  let title: string
  let middle: string
  switch (run.status) {
    case 'streaming':
      template = 'blue'
      title = run.answerText === '' ? '⌘ btw · 思考中' : '⌘ btw · 回答中'
      middle = run.answerText === ''
        ? '_旁路调用运行中，不占用主线……_'
        : btwAnswerTail(run.answerText)
      break
    case 'done':
      template = 'green'
      title = '✅ btw'
      middle = run.answerText === '' ? '_（无回答文本）_' : btwAnswerTail(run.answerText)
      break
    case 'error':
      template = 'red'
      title = '❌ btw 失败'
      middle = `✘ ${run.error ?? '未知错误'}`
      break
    case 'canceled':
      template = 'grey'
      title = '⛔ btw 已取消'
      middle = run.answerText === '' ? '_随主线变故取消，未产出回答。_' : btwAnswerTail(run.answerText)
      break
  }
  const footer = run.status === 'streaming'
    ? `与主线并行 · 不进会话记录${queuedSuffix}`
    : `${FOOTER_NOTE}${queuedSuffix}`
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: `dsh · ${run.modelLabel}` },
      template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `${questionQuote(run.question)}\n\n${middle}\n---\n${clipLine(footer, 80)}`,
        },
      ],
    },
  }
}
