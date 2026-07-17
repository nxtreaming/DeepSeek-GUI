import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryUserInputGate } from '../adapters/in-memory-user-input-gate.js'
import { createApprovalRequest } from '../domain/approval.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import type { SessionStore } from '../ports/session-store.js'
import { InteractiveToolBridge } from './interactive-tool-bridge.js'

describe('InteractiveToolBridge', () => {
  it('arms an approval before its requested event is observed', async () => {
    const approvalGate = new InMemoryApprovalGate()
    let immediatelyAllowed = false
    const bridge = new InteractiveToolBridge({
      approvalGate,
      userInputGate: new InMemoryUserInputGate(),
      events: {
        record: async (event: { kind: string; approvalId?: string }) => {
          if (event.kind === 'approval_requested' && event.approvalId) {
            immediatelyAllowed = approvalGate.decide(event.approvalId, 'allow')
          }
        }
      } as never,
      turns: {} as TurnService,
      sessionStore: {} as SessionStore,
      nowIso: () => '2026-07-10T00:00:00.000Z'
    })

    await expect(bridge.awaitApproval({
      approval: createApprovalRequest({
        id: 'approval_1', threadId: 'thread_1', turnId: 'turn_1', toolName: 'write', summary: 'Write file'
      }),
      approvalPolicy: 'always',
      sandboxMode: 'workspace-write',
      signal: new AbortController().signal
    })).resolves.toEqual({ decision: 'allow' })
    expect(immediatelyAllowed).toBe(true)
  })

  it('persists the user-input item before its request event and settles once', async () => {
    const userInputGate = new InMemoryUserInputGate()
    const order: string[] = []
    const turns = {
      applyItem: vi.fn(async () => { order.push('item_created') }),
      updateItem: vi.fn(async () => { order.push('item_updated') })
    } as unknown as TurnService
    const events = {
      record: vi.fn(async (event: { kind: string; inputId?: string }) => {
        order.push(event.kind)
        if (event.kind === 'user_input_requested' && event.inputId) {
          expect(userInputGate.resolve(event.inputId, { status: 'submitted', answers: [] })).toBe(true)
        }
      })
    } as unknown as RuntimeEventRecorder
    const bridge = new InteractiveToolBridge({
      approvalGate: new InMemoryApprovalGate(),
      userInputGate,
      events,
      turns,
      sessionStore: { loadEventsSince: async () => [] } as unknown as SessionStore,
      nowIso: () => '2026-07-10T00:00:00.000Z'
    })

    await expect(bridge.awaitUserInput({
      threadId: 'thread_1',
      turnId: 'turn_1',
      input: { id: 'input_1', itemId: 'item_input_1', prompt: 'Continue?', questions: [] },
      signal: new AbortController().signal
    })).resolves.toEqual({ status: 'submitted', answers: [] })

    expect(order).toEqual([
      'item_created',
      'user_input_requested',
      'item_updated',
      'user_input_resolved'
    ])
  })
})
