import { describe, expect, it } from 'vitest'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { emptyUsageSnapshot } from '../src/contracts/usage.js'
import type { ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'
import {
  CapturingToolHost,
  ScriptedCapturingModel,
  captureTranscript,
  runTranscript
} from './loop-transcript-harness.js'

describe('AgentLoop transcript characterization', () => {
  it('replays a text, reasoning, and usage turn through stable public boundaries', async () => {
    const model = new ScriptedCapturingModel([[
      { kind: 'assistant_reasoning_delta', text: 'First inspect the request.' },
      { kind: 'assistant_text_delta', text: 'The request is healthy.' },
      {
        kind: 'usage',
        usage: {
          ...emptyUsageSnapshot(),
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
          turns: 1
        }
      },
      { kind: 'completed', stopReason: 'stop' }
    ]])
    const harness = makeHarness(model, { tools: [] })
    await bootstrapThread(harness, {
      request: {
        prompt: 'Assess the request.',
        model: 'transcript-model',
        reasoningEffort: 'high'
      }
    })

    const transcript = await runTranscript({ harness, model })

    expect(transcript.status).toBe('completed')
    expect(transcript.modelRequests).toHaveLength(1)
    expect(transcript.modelRequests[0]).toMatchObject({
      threadId: 'thr_1',
      turnId: 'turn_1',
      model: 'transcript-model',
      reasoningEffort: 'high',
      tools: [],
      history: [
        expect.objectContaining({
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'Assess the request.'
        })
      ]
    })
    expect(transcript.sessionItems).toEqual([
      expect.objectContaining({ kind: 'user_message', text: 'Assess the request.' }),
      expect.objectContaining({ kind: 'assistant_reasoning', text: 'First inspect the request.' }),
      expect.objectContaining({ kind: 'assistant_text', text: 'The request is healthy.' })
    ])
    expect(transcript.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'turn_started',
      'assistant_reasoning_delta',
      'assistant_text_delta',
      'usage',
      'turn_completed'
    ]))
    expect(transcript.usage).toMatchObject({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      turns: 1
    })
    expect(transcript.eventProjection).toMatchObject({
      lastSeq: transcript.events.at(-1)?.seq,
      usage: expect.objectContaining({ totalTokens: 18 }),
      turns: [expect.objectContaining({ status: 'completed' })]
    })
    expect(transcript.thread).toMatchObject({ id: 'thr_1', status: 'idle' })
    expect(transcript.turn).toMatchObject({ id: 'turn_1', status: 'completed' })
    expect(transcript.toolExecutionOrder).toEqual([])
  })

  it('replays a tool round-trip with request history and execution order intact', async () => {
    const model = new ScriptedCapturingModel([
      [
        {
          kind: 'tool_call_complete',
          callId: 'call_echo',
          toolName: 'echo',
          arguments: { text: 'ping' }
        },
        { kind: 'completed', stopReason: 'tool_calls' }
      ],
      [
        { kind: 'assistant_text_delta', text: 'Echoed ping.' },
        { kind: 'completed', stopReason: 'stop' }
      ]
    ])
    const echo = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo input text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async (args) => ({ output: { echoed: args.text } })
    })
    const toolHost = new CapturingToolHost({ tools: [echo] })
    const harness = makeHarness(model, { toolHost })
    await bootstrapThread(harness, {
      request: { prompt: 'Please echo ping.', model: 'transcript-model' }
    })

    const transcript = await runTranscript({ harness, model, toolHost })

    expect(transcript.status).toBe('completed')
    expect(transcript.modelRequests).toHaveLength(2)
    expect(transcript.modelRequests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'echo', toolKind: 'tool_call' })
    ])
    expect(transcript.modelRequests[1]?.history.map((item) => item.kind)).toEqual([
      'user_message',
      'tool_call',
      'tool_result'
    ])
    expect(transcript.toolExecutionOrder).toEqual([
      {
        callId: 'call_echo',
        toolName: 'echo',
        providerId: 'builtin',
        toolKind: 'tool_call',
        arguments: { text: 'ping' }
      }
    ])
    expect(transcript.sessionItems.map((item) => item.kind)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'assistant_text'
    ])
    expect(transcript.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'tool_call_ready',
      'tool_result_upload_wait',
      'turn_completed'
    ]))
    expect(transcript.turn).toMatchObject({ status: 'completed' })
  })

  it('replays an interrupt without timers and preserves the abort lifecycle contract', async () => {
    let markModelWaiting: (() => void) | undefined
    const modelWaiting = new Promise<void>((resolve) => {
      markModelWaiting = resolve
    })
    const model = new ScriptedCapturingModel([
      async function *({ request }): AsyncIterable<ModelStreamChunk> {
        yield { kind: 'assistant_text_delta', text: 'Partial response.' }
        markModelWaiting?.()
        await waitForAbort(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    ])
    const harness = makeHarness(model, { tools: [] })
    await bootstrapThread(harness, {
      request: { prompt: 'Start then stop.', model: 'transcript-model' }
    })

    const running = harness.loop.runTurn(harness.threadId, harness.turnId)
    await modelWaiting
    await harness.turns.interruptTurn({ threadId: harness.threadId, turnId: harness.turnId })
    const status = await running
    const transcript = await captureTranscript({ harness, model, status })

    expect(transcript.status).toBe('aborted')
    expect(transcript.modelRequests).toHaveLength(1)
    expect(transcript.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'assistant_text_delta',
      'turn_aborted'
    ]))
    expect(transcript.events.some((event) => event.kind === 'turn_completed')).toBe(false)
    expect(transcript.sessionItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant_text', text: 'Partial response.' })
    ]))
    expect(transcript.thread).toMatchObject({ status: 'idle' })
    expect(transcript.turn).toMatchObject({ status: 'aborted' })
    expect(harness.inflight.size()).toBe(0)
  })
})

function waitForAbort(request: ModelRequest): Promise<void> {
  return new Promise((resolve) => {
    if (request.abortSignal.aborted) {
      resolve()
      return
    }
    request.abortSignal.addEventListener('abort', () => resolve(), { once: true })
  })
}
