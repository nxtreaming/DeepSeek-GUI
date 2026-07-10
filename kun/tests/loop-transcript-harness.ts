import type { RuntimeEvent } from '../src/contracts/events.js'
import type { TurnItem } from '../src/contracts/items.js'
import type { ThreadRecord } from '../src/contracts/threads.js'
import type { Turn, TurnStatus } from '../src/contracts/turns.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { replayRuntimeEvents } from '../src/domain/runtime-event-reducer.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import type {
  ToolCallLike,
  ToolHostContext,
  ToolHostResult
} from '../src/ports/tool-host.js'
import type { Harness } from './loop-test-harness.js'

/**
 * JSON-safe projection used by the loop transcript tests. It intentionally
 * preserves semantic order while dropping clock values and AbortSignal
 * internals, which would otherwise make the characterization fixtures flaky.
 */
export type TranscriptValue =
  | null
  | boolean
  | number
  | string
  | TranscriptValue[]
  | { [key: string]: unknown }

export type NormalizedRecord = { [key: string]: unknown }

export type NormalizedModelRequest = {
  threadId: string
  turnId: string
  model: string
  providerId?: string
  systemPrompt?: string
  modeInstruction?: string
  contextInstructions: string[]
  prefix: NormalizedTurnItem[]
  history: NormalizedTurnItem[]
  tools: Array<{
    name: string
    description: string
    toolKind?: 'tool_call' | 'command_execution' | 'file_change'
    inputSchema: TranscriptValue
  }>
  requiredToolName?: string
  stream?: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  responseFormat?: 'json_object'
  reasoningEffort?: string
  attachments?: TranscriptValue
  attachmentTextFallbacks?: TranscriptValue
  attachmentDocuments?: TranscriptValue
}

export type NormalizedRuntimeEvent = NormalizedRecord & {
  kind: RuntimeEvent['kind']
  seq: number
}

export type NormalizedTurnItem = NormalizedRecord & {
  id: string
  threadId: string
  turnId: string
  kind: TurnItem['kind']
  role: TurnItem['role']
  status: TurnItem['status']
}

export type NormalizedTurn = NormalizedRecord & {
  id: string
  threadId: string
  status: TurnStatus
  items: NormalizedTurnItem[]
}

export type NormalizedThread = NormalizedRecord & {
  id: string
  status: ThreadRecord['status']
  turns: NormalizedTurn[]
}

export type ToolExecutionTrace = {
  callId: string
  toolName: string
  providerId?: string
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  arguments: TranscriptValue
}

export type LoopTranscript = {
  status: TurnStatus
  modelRequests: NormalizedModelRequest[]
  events: NormalizedRuntimeEvent[]
  eventProjection: TranscriptValue
  sessionItems: NormalizedTurnItem[]
  thread: NormalizedThread | null
  turn: NormalizedTurn | null
  usage: TranscriptValue
  toolExecutionOrder: ToolExecutionTrace[]
}

export type ModelScript =
  | readonly ModelStreamChunk[]
  | ((input: {
    request: ModelRequest
    callIndex: number
  }) => AsyncIterable<ModelStreamChunk>)

/**
 * A fully offline model double that records the request boundary before
 * replaying a deterministic sequence of model chunks.
 */
export class ScriptedCapturingModel implements ModelClient {
  readonly provider: string
  readonly model: string
  readonly requests: NormalizedModelRequest[] = []
  private callIndex = 0

  constructor(
    private readonly scripts: readonly ModelScript[],
    options: { provider?: string; model?: string } = {}
  ) {
    this.provider = options.provider ?? 'transcript'
    this.model = options.model ?? 'transcript-model'
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(normalizeModelRequest(request))
    const callIndex = this.callIndex
    this.callIndex += 1
    const script = this.scripts[callIndex] ?? []
    const chunks = typeof script === 'function'
      ? script({ request, callIndex })
      : asAsyncIterable(script)
    for await (const chunk of chunks) yield chunk
  }
}

/**
 * Records the externally observable execution order while retaining the real
 * tool host, approval, sandbox, and result behavior underneath.
 */
export class CapturingToolHost extends LocalToolHost {
  readonly executions: ToolExecutionTrace[] = []

  override async execute(
    call: ToolCallLike,
    context: ToolHostContext,
    onUpdate?: (item: TurnItem) => Promise<void> | void
  ): Promise<ToolHostResult> {
    this.executions.push({
      callId: call.callId,
      toolName: call.toolName,
      ...(call.providerId ? { providerId: call.providerId } : {}),
      ...(call.toolKind ? { toolKind: call.toolKind } : {}),
      arguments: normalizeTranscriptValue(call.arguments)
    })
    return super.execute(call, context, onUpdate)
  }
}

/** Run one initialized harness turn and capture its durable/public boundary. */
export async function runTranscript(input: {
  harness: Harness
  model: ScriptedCapturingModel
  toolHost?: CapturingToolHost
}): Promise<LoopTranscript> {
  const status = await input.harness.loop.runTurn(input.harness.threadId, input.harness.turnId)
  return captureTranscript({ ...input, status })
}

/** Capture a transcript after a turn is settled outside `runTranscript` (e.g. interrupt tests). */
export async function captureTranscript(input: {
  harness: Harness
  model: ScriptedCapturingModel
  status: TurnStatus
  toolHost?: CapturingToolHost
}): Promise<LoopTranscript> {
  const [events, sessionItems, thread] = await Promise.all([
    input.harness.sessionStore.loadEventsSince(input.harness.threadId, 0),
    input.harness.sessionStore.loadItems(input.harness.threadId),
    input.harness.threadStore.get(input.harness.threadId)
  ])
  const turn = thread?.turns.find((candidate) => candidate.id === input.harness.turnId) ?? null
  return {
    status: input.status,
    modelRequests: [...input.model.requests],
    events: events.map(normalizeRuntimeEvent),
    eventProjection: normalizeTranscriptValue(replayRuntimeEvents(events)),
    sessionItems: sessionItems.map(normalizeTurnItem),
    thread: thread ? normalizeThread(thread) : null,
    turn: turn ? normalizeTurn(turn) : null,
    usage: normalizeTranscriptValue(input.harness.usage.forThread(input.harness.threadId)),
    toolExecutionOrder: [...(input.toolHost?.executions ?? [])]
  }
}

export function normalizeModelRequest(request: ModelRequest): NormalizedModelRequest {
  return {
    threadId: request.threadId,
    turnId: request.turnId,
    model: request.model,
    ...(request.providerId ? { providerId: request.providerId } : {}),
    ...(request.systemPrompt ? { systemPrompt: normalizeText(request.systemPrompt) } : {}),
    ...(request.modeInstruction ? { modeInstruction: normalizeText(request.modeInstruction) } : {}),
    contextInstructions: (request.contextInstructions ?? []).map(normalizeText),
    prefix: request.prefix.map(normalizeTurnItem),
    history: request.history.map(normalizeTurnItem),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: normalizeText(tool.description),
      ...(tool.toolKind ? { toolKind: tool.toolKind } : {}),
      inputSchema: normalizeTranscriptValue(tool.inputSchema)
    })),
    ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {}),
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.attachments ? { attachments: normalizeTranscriptValue(request.attachments) } : {}),
    ...(request.attachmentTextFallbacks
      ? { attachmentTextFallbacks: normalizeTranscriptValue(request.attachmentTextFallbacks) }
      : {}),
    ...(request.attachmentDocuments
      ? { attachmentDocuments: normalizeTranscriptValue(request.attachmentDocuments) }
      : {})
  }
}

export function normalizeRuntimeEvent(event: RuntimeEvent): NormalizedRuntimeEvent {
  return {
    ...(normalizeTranscriptValue(event) as NormalizedRecord),
    kind: event.kind,
    seq: event.seq
  }
}

export function normalizeTurnItem(item: TurnItem): NormalizedTurnItem {
  return {
    ...(normalizeTranscriptValue(item) as NormalizedRecord),
    id: item.id,
    threadId: item.threadId,
    turnId: item.turnId,
    kind: item.kind,
    role: item.role,
    status: item.status
  }
}

export function normalizeTurn(turn: Turn): NormalizedTurn {
  return {
    ...(normalizeTranscriptValue(turn) as NormalizedRecord),
    id: turn.id,
    threadId: turn.threadId,
    status: turn.status,
    items: turn.items.map(normalizeTurnItem)
  }
}

export function normalizeThread(thread: ThreadRecord): NormalizedThread {
  return {
    ...(normalizeTranscriptValue(thread) as NormalizedRecord),
    id: thread.id,
    status: thread.status,
    turns: thread.turns.map(normalizeTurn)
  }
}

/**
 * Sort object keys and remove wall-clock fields so assertions describe the
 * compatibility contract, not the incidental implementation timestamps.
 */
export function normalizeTranscriptValue(value: unknown): TranscriptValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return normalizeText(value)
  if (Array.isArray(value)) return value.map(normalizeTranscriptValue)
  if (typeof value === 'object') {
    const normalized: { [key: string]: TranscriptValue } = {}
    for (const [key, nested] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      if (isVolatileTranscriptField(key) || nested === undefined) continue
      normalized[key] = normalizeTranscriptValue(nested)
    }
    return normalized
  }
  return String(value)
}

function asAsyncIterable(chunks: readonly ModelStreamChunk[]): AsyncIterable<ModelStreamChunk> {
  return (async function *scriptedChunks(): AsyncIterable<ModelStreamChunk> {
    for (const chunk of chunks) yield chunk
  })()
}

function isVolatileTranscriptField(field: string): boolean {
  return field === 'abortSignal' ||
    field === 'timestamp' ||
    field === 'createdAt' ||
    field === 'updatedAt' ||
    field === 'startedAt' ||
    field === 'finishedAt'
}

function normalizeText(value: string): string {
  return value
    // ISO values occur in runtime-context prompt injection and event payloads.
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g, '<timestamp>')
    // Localized runtime-context prompt injection has a user-local clock.
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/g, '<local-time>')
}
