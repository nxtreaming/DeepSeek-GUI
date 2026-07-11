import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  AppSettingsV1,
  WorkflowConnectionV1,
  WorkflowEnvVarV1,
  WorkflowInputFieldV1,
  WorkflowApprovalDecision,
  WorkflowNodeRunResultV1,
  WorkflowNodeTestResult,
  WorkflowPendingApprovalV1,
  WorkflowNodeRunStatus,
  WorkflowNodeV1,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowRunV1,
  WorkflowRuntimeStatus,
  WorkflowScheduleV1,
  WorkflowV1
} from '../shared/app-settings'
import { MAX_WORKFLOW_RUNS } from '../shared/app-settings-workflow'
import {
  SCHEDULER_INTERVAL_MS,
  hasEnabledScheduledTask,
  parseJsonObject,
  readRequestBody,
  sleep,
  writeJson,
  type ScheduleRuntimeDeps
} from './schedule-runtime-helpers'
import { createWorkflowExecutionPlan, selectWorkflowTrigger } from './workflow-graph-planner'
import { WorkflowRunCoordinator } from './workflow-run-coordinator'
import { WorkflowScheduler } from './workflow-scheduler'
import { createWorkflowNodeExecutorRegistry } from './workflow-node-executor-registry'
import {
  evaluateCondition,
  getByPath,
  interpolate,
  resolveExpr,
  safeJson,
  stringifyValue,
  type InterpScope,
  type WorkflowPayload
} from './workflow-expression'
import { executeCoreWorkflowNode, isCoreWorkflowNode } from './workflow-core-node-adapter'
import { executeHttpWorkflowNode } from './workflow-http-node-adapter'
import { executeAiWorkflowNode } from './workflow-ai-node-adapter'
import { executeImageWorkflowNode } from './workflow-image-node-adapter'
import {
  executeCodeWorkflowNode,
  executeCustomWorkflowNode
} from './workflow-code-node-adapter'

export { checkWorkflowCode } from './workflow-code-node-adapter'

const MAX_NODE_EXECUTIONS = 200
const MAX_RUN_DURATION_MS = 30 * 60_000
/** Sentinel branch that matches no output handle (e.g. switch with no rule + no fallback). */
const NO_BRANCH = '__none__'
const LIVE_STATUS_LINGER_MS = 8_000
const MAX_SUBWORKFLOW_DEPTH = 5

type ScheduleTriggerNode = Extract<WorkflowNodeV1, { type: 'schedule-trigger' }>

type NodeOutcome = {
  payload: WorkflowPayload
  message: string
  /** For condition nodes: which outgoing handle to follow ('true' | 'false'). */
  branch?: string
  /** For ai-agent nodes: the Kun thread created. */
  threadId?: string
}

type NodeExecutionContext = {
  payload: WorkflowPayload
  settings: AppSettingsV1
  inputs: WorkflowPayload[]
  depth: number
  runWorkspace: string
  scope: InterpScope
  runVars: Record<string, unknown>
  runRef?: { workflowId: string; runId: string }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isScheduleTrigger(node: WorkflowNodeV1): node is ScheduleTriggerNode {
  return node.type === 'schedule-trigger'
}

function activeScheduleTriggers(workflow: WorkflowV1): ScheduleTriggerNode[] {
  return workflow.nodes
    .filter(isScheduleTrigger)
    .filter((node) => !node.disabled && node.config.schedule.kind !== 'manual')
}

export function workflowHasScheduleTrigger(workflow: WorkflowV1): boolean {
  return activeScheduleTriggers(workflow).length > 0
}

export function hasEnabledScheduledWorkflow(settings: AppSettingsV1): boolean {
  return settings.workflow.workflows.some((workflow) => workflow.enabled && workflowHasScheduleTrigger(workflow))
}

/** Minimal, dependency-free 5-field cron field parser ("* , - /"). */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const match = part.trim().match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/)
    if (!match) return null
    const star = match[1] === '*'
    const lo = star ? min : Number(match[1])
    const hi = star ? max : match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? max : lo
    const step = match[3] !== undefined ? Number(match[3]) : 1
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || step < 1) return null
    for (let value = lo; value <= hi; value += step) {
      if (value >= min && value <= max) out.add(value)
    }
  }
  return out.size ? out : null
}

/** Next fire time at or after `from` for a standard "min hour dom month dow" cron, in local time. */
export function cronNextRun(expr: string, from: Date): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const doms = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const dowsRaw = parseCronField(parts[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set([...dowsRaw].map((day) => (day === 7 ? 0 : day)))
  const domRestricted = parts[2].trim() !== '*'
  const dowRestricted = parts[4].trim() !== '*'

  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i += 1) {
    if (months.has(cursor.getMonth() + 1)) {
      const dom = cursor.getDate()
      const dow = cursor.getDay()
      // Standard cron: when both DOM and DOW are restricted, match either.
      const dayOk =
        domRestricted && dowRestricted
          ? doms.has(dom) || dows.has(dow)
          : (domRestricted ? doms.has(dom) : true) && (dowRestricted ? dows.has(dow) : true)
      if (dayOk && hours.has(cursor.getHours()) && minutes.has(cursor.getMinutes())) {
        return new Date(cursor.getTime())
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

function nextRunFromSchedule(schedule: WorkflowScheduleV1, from: Date): string {
  switch (schedule.kind) {
    case 'manual':
      return ''
    case 'at':
      return schedule.atTime.trim()
    case 'interval':
      return new Date(from.getTime() + schedule.everyMinutes * 60_000).toISOString()
    case 'cron': {
      const next = schedule.cron.trim() ? cronNextRun(schedule.cron, from) : null
      return next ? next.toISOString() : ''
    }
    case 'daily':
    default: {
      const [hourRaw, minuteRaw] = schedule.timeOfDay.split(':')
      const hour = Number(hourRaw)
      const minute = Number(minuteRaw)
      const next = new Date(from)
      next.setSeconds(0, 0)
      next.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
      return next.toISOString()
    }
  }
}

export function computeWorkflowNextRunAt(workflow: WorkflowV1, from: Date): string {
  if (!workflow.enabled) return ''
  const candidates = activeScheduleTriggers(workflow)
    .map((node) => nextRunFromSchedule(node.config.schedule, from).trim())
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .sort()
  return candidates[0] ?? ''
}

function buildAdjacency(connections: WorkflowConnectionV1[]): Map<string, WorkflowConnectionV1[]> {
  const map = new Map<string, WorkflowConnectionV1[]>()
  for (const edge of connections) {
    const list = map.get(edge.source) ?? []
    list.push(edge)
    map.set(edge.source, list)
  }
  return map
}

/**
 * The run's working directory: the firing trigger's workspaceRoot, else the
 * workflow-settings default, else the app workspace. Used as the default cwd
 * for AI / image / code nodes that don't set their own.
 */
function coerceInputFieldValue(field: WorkflowInputFieldV1, raw: unknown): unknown {
  const asString = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw)
  switch (field.type) {
    case 'number':
      return typeof raw === 'number' ? raw : asString.trim() === '' ? 0 : Number(asString) || 0
    case 'boolean':
      return typeof raw === 'boolean' ? raw : asString === 'true' || asString === '1'
    case 'json':
      if (raw && typeof raw === 'object') return raw
      try {
        return JSON.parse(asString)
      } catch {
        return asString
      }
    default:
      return raw && typeof raw === 'object' ? raw : asString
  }
}

/** Build the run's initial payload from the manual trigger's input schema (or pass input through verbatim). */
function coerceInputToPayload(schema: WorkflowInputFieldV1[] | undefined, input: unknown): WorkflowPayload {
  if (!schema || schema.length === 0) {
    if (input === undefined || input === null) return { json: {}, text: '' }
    if (typeof input === 'string') return { json: { text: input }, text: input }
    return { json: input, text: safeJson(input) }
  }
  let src: Record<string, unknown> = {}
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    src = input as Record<string, unknown>
  } else if (typeof input === 'string' && input.trim()) {
    try {
      const parsed = JSON.parse(input)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) src = parsed as Record<string, unknown>
    } catch {
      /* not a JSON object — fields fall back to defaults */
    }
  }
  const json: Record<string, unknown> = {}
  for (const field of schema) {
    json[field.key] = coerceInputFieldValue(field, field.key in src ? src[field.key] : field.defaultValue)
  }
  return { json, text: safeJson(json) }
}

/** Returns the first required input key missing from `input`, or null if all present. */
function missingRequiredInput(schema: WorkflowInputFieldV1[] | undefined, input: unknown): string | null {
  if (!schema) return null
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  for (const field of schema) {
    if (field.required && !(field.key in src) && !field.defaultValue.trim()) return field.label || field.key
  }
  return null
}

/** Run `fn` over items with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) break
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Replace every secret value with *** in a string. */
function redactSecrets(secretValues: string[], text: string): string {
  return secretValues.reduce((acc, secret) => acc.split(secret).join('***'), text)
}

/**
 * All secret-typed env values across every workflow. Used so a parent run redacts
 * secrets that belong to a sub-workflow / loop body it invoked, not just its own.
 */
function collectSecretValues(settings: AppSettingsV1): string[] {
  const values: string[] = []
  for (const workflow of settings.workflow.workflows) {
    for (const entry of workflow.env) {
      if (entry.type === 'secret' && entry.value.trim()) values.push(entry.value)
    }
  }
  return values
}

/** Coerce a resolved node-input value to its declared type. */
function coerceNodeInputValue(type: 'text' | 'number' | 'boolean' | 'json', raw: unknown): unknown {
  switch (type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
      return Number.isFinite(n) ? n : 0
    }
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1'
    case 'json': {
      if (raw && typeof raw === 'object') return raw
      try {
        return JSON.parse(String(raw ?? ''))
      } catch {
        return raw ?? null
      }
    }
    default:
      return typeof raw === 'string' ? raw : raw == null ? '' : safeJson(raw)
  }
}

/**
 * Resolve a node's typed inputs (bound to upstream output) into a {{$input.key}}
 * lookup. A single `{{ expr }}` source yields the raw value (object/number/…);
 * anything else is interpolated as a string. Returns undefined when no inputs.
 */
function resolveNodeInputs(
  node: WorkflowNodeV1,
  payload: WorkflowPayload,
  scope: InterpScope
): Record<string, unknown> | undefined {
  const bindings = node.inputs
  if (!bindings || bindings.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const binding of bindings) {
    const key = binding.key.trim()
    if (!key) continue
    const single = binding.source.trim().match(/^\{\{([^}]+)\}\}$/)
    const raw = single ? resolveExpr(payload, single[1], scope) : interpolate(binding.source, payload, scope)
    out[key] = coerceNodeInputValue(binding.type, raw)
  }
  return out
}

/** Coerce a workflow's env vars into a {{$env.key}} lookup (secrets are plain values here). */
function resolveEnv(env: WorkflowEnvVarV1[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const entry of env) {
    if (!entry.key) continue
    out[entry.key] =
      entry.type === 'number'
        ? Number(entry.value) || 0
        : entry.type === 'boolean'
          ? entry.value === 'true'
          : entry.value
  }
  return out
}

function resolveRunWorkspace(
  workflow: WorkflowV1,
  settings: AppSettingsV1,
  triggerNodeId?: string,
  payload?: WorkflowPayload,
  scope?: InterpScope
): string {
  const triggers = workflow.nodes.filter(
    (node) =>
      node.type === 'manual-trigger' || node.type === 'schedule-trigger' || node.type === 'webhook-trigger'
  )
  const trigger = (triggerNodeId ? triggers.find((node) => node.id === triggerNodeId) : undefined) ?? triggers[0]
  const rawWorkspace =
    trigger && typeof (trigger.config as { workspaceRoot?: unknown }).workspaceRoot === 'string'
      ? (trigger.config as { workspaceRoot: string }).workspaceRoot
      : ''
  // The trigger's working directory may reference the run input ({{json.dir}} /
  // {{$env.X}}), so the working directory itself can be passed in as a parameter.
  const triggerWorkspace = (payload ? interpolate(rawWorkspace, payload, scope) : rawWorkspace).trim()
  return triggerWorkspace || settings.workflow.defaultWorkspaceRoot.trim() || settings.workspaceRoot
}

function summarizeRun(results: WorkflowNodeRunResultV1[]): string {
  const lastMeaningful = [...results].reverse().find((result) => result.status === 'success' && result.message.trim())
  if (lastMeaningful) return lastMeaningful.message
  return `Completed ${results.length} step${results.length === 1 ? '' : 's'}`
}

/** Short description of a workflow for the agent's run_workflow / list_workflows tools. */
function summarizeWorkflowForAgent(workflow: WorkflowV1): string {
  const steps = workflow.nodes.filter((node) => node.type === 'ai-agent' || node.type === 'custom').length
  const kinds = [...new Set(workflow.nodes.map((node) => node.type))].filter(
    (kind) => kind !== 'manual-trigger' && kind !== 'schedule-trigger' && kind !== 'webhook-trigger'
  )
  return `${workflow.nodes.length} nodes${steps ? `, ${steps} AI step(s)` : ''} — ${kinds.slice(0, 6).join(', ') || 'trigger only'}`
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  private readonly deps: ScheduleRuntimeDeps
  private readonly runCoordinator = new WorkflowRunCoordinator()
  private readonly scheduler: WorkflowScheduler
  private readonly nodeExecutors = createWorkflowNodeExecutorRegistry<NodeOutcome>()
  private workflowUpdateTail: Promise<void> = Promise.resolve()
  /** Recursion guard: true while a hook-triggered workflow is running, so its own
   * tool calls (via AI-agent nodes) don't re-trigger hooks and loop forever. */
  private hookRunActive = false
  private powerSaveBlockerId: number | null = null
  private webhookServer: Server | null = null
  private webhookServerKey = ''

  constructor(deps: ScheduleRuntimeDeps) {
    this.deps = deps
    this.scheduler = new WorkflowScheduler({
      intervalMs: SCHEDULER_INTERVAL_MS,
      tick: () => this.tick()
    })
  }

  sync(settings: AppSettingsV1): void {
    this.startScheduler()
    this.syncPowerSaveBlocker(settings)
    this.syncWebhookServer(settings)
    void this.ensureNextRuns(settings)
  }

  stop(): void {
    this.scheduler.stop()
    this.stopPowerSaveBlocker()
    this.closeWebhookServer()
  }

  private syncWebhookServer(settings: AppSettingsV1): void {
    // The same local server hosts webhook-trigger paths, /workflow/internal/* (agent
    // tool) and the public POST /workflow/run, so listen whenever workflows are on.
    const shouldListen = settings.workflow.enabled && settings.workflow.workflows.length > 0
    if (!shouldListen) {
      this.closeWebhookServer()
      return
    }
    const key = String(settings.workflow.webhookPort)
    if (this.webhookServer && this.webhookServerKey === key) return
    this.closeWebhookServer()
    const server = createServer((req, res) => {
      void this.handleWebhookRequest(req, res)
    })
    server.on('error', (error) => {
      this.deps.logError('workflow-webhook', 'Webhook server failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      if (this.webhookServer === server) this.closeWebhookServer()
    })
    // Bind to localhost only — never expose the listener to the network.
    server.listen(settings.workflow.webhookPort, '127.0.0.1')
    this.webhookServer = server
    this.webhookServerKey = key
  }

  private closeWebhookServer(): void {
    if (!this.webhookServer) return
    const server = this.webhookServer
    this.webhookServer = null
    this.webhookServerKey = ''
    server.close()
  }

  private async handleWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const settings = await this.deps.store.load()
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const secret = settings.workflow.webhookSecret.trim()
      if (secret) {
        const rawHeader = req.headers['x-kun-secret']
        const headerSecret = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
        if (req.headers.authorization !== `Bearer ${secret}` && headerSecret !== secret) {
          writeJson(res, 401, { ok: false, message: 'Unauthorized.' })
          return
        }
      }
      // Internal endpoints used by the GUI-hosted workflow MCP server (agent tool)
      // and the kun hook bridge.
      if (
        pathname === '/workflow/internal/list' ||
        pathname === '/workflow/internal/run' ||
        pathname === '/workflow/internal/hook-run'
      ) {
        await this.handleInternalRequest(pathname, req, res, settings)
        return
      }
      // Public local API: run any workflow by name/id and get its output back.
      if (pathname === '/workflow/run') {
        const body = await readRequestBody(req)
        const parsed = parseJsonObject(body) ?? {}
        const idOrName = String(parsed.workflow ?? parsed.name ?? parsed.workflowId ?? '').trim()
        if (!idOrName) {
          writeJson(res, 400, { ok: false, message: 'Provide a workflow name or id.' })
          return
        }
        const workspaceOverride = typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : undefined
        const result = await this.runWorkflowByRef(idOrName, parsed.input, workspaceOverride)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      const method = req.method ?? 'GET'
      let match: { workflow: WorkflowV1; nodeId: string } | null = null
      for (const workflow of settings.workflow.workflows) {
        if (!workflow.enabled) continue
        for (const node of workflow.nodes) {
          if (node.type !== 'webhook-trigger' || node.disabled) continue
          if (node.config.path !== pathname) continue
          if (node.config.method !== 'ANY' && node.config.method !== method) continue
          match = { workflow, nodeId: node.id }
          break
        }
        if (match) break
      }
      if (!match) {
        writeJson(res, 404, { ok: false, message: 'No enabled workflow matches this webhook.' })
        return
      }
      const body = await readRequestBody(req)
      const parsed = parseJsonObject(body)
      const runId = randomUUID()
      void this.runWorkflowInternal(match.workflow, match.nodeId, 'webhook', runId, {
        json: parsed ?? body,
        text: body
      })
      writeJson(res, 200, { ok: true, runId })
    } catch (error) {
      this.deps.logError('workflow-webhook', 'Webhook request failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      try {
        writeJson(res, 500, { ok: false, message: 'Internal error.' })
      } catch {
        /* response already sent */
      }
    }
  }

  private async handleInternalRequest(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    settings: AppSettingsV1
  ): Promise<void> {
    if (pathname === '/workflow/internal/list') {
      const workflows = settings.workflow.workflows
        .filter((workflow) => workflow.enabled && workflow.callableByAgent)
        .map((workflow) => {
          const manual = workflow.nodes.find((node) => node.type === 'manual-trigger')
          const schema = manual?.type === 'manual-trigger' ? manual.config.inputSchema : undefined
          const inputs = (schema ?? []).map((field) => ({
            key: field.key,
            type: field.type,
            required: field.required,
            description: field.description || field.label
          }))
          return { id: workflow.id, name: workflow.name, description: summarizeWorkflowForAgent(workflow), inputs }
        })
      writeJson(res, 200, { ok: true, workflows })
      return
    }
    const body = await readRequestBody(req)
    const parsed = parseJsonObject(body) ?? {}
    const idOrName = String(parsed.workflow ?? parsed.name ?? parsed.workflowId ?? '').trim()
    if (!idOrName) {
      writeJson(res, 400, { ok: false, message: 'Provide a workflow name or id.' })
      return
    }
    const workspaceOverride = typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : undefined
    if (pathname === '/workflow/internal/hook-run') {
      // The hook payload (the kun invocation) is the workflow input; nodes read it via {{json.*}}.
      const result = await this.runForHook(idOrName, parsed.payload ?? parsed.input, workspaceOverride)
      writeJson(res, 200, result)
      return
    }
    const result = await this.runWorkflowForTool(idOrName, parsed.input, workspaceOverride)
    writeJson(res, result.ok ? 200 : 400, result)
  }

  /** Run a workflow on behalf of the Kun agent tool: resolve by id/name, await it, return its output. */
  async runWorkflowForTool(
    idOrName: string,
    input?: unknown,
    workspaceOverride?: string
  ): Promise<{ ok: boolean; status: WorkflowRunStatus; message: string; output: string; runId: string }> {
    const settings = await this.deps.store.load()
    const lower = idOrName.toLowerCase()
    const workflow = settings.workflow.workflows.find(
      (item) => item.enabled && item.callableByAgent && (item.id === idOrName || item.name.toLowerCase() === lower)
    )
    if (!workflow) {
      return { ok: false, status: 'error', message: `No agent-callable workflow matches "${idOrName}".`, output: '', runId: '' }
    }
    return this.runResolved(workflow, input, workspaceOverride)
  }

  /**
   * Run a workflow triggered by a kun agent hook. Resolves by id (no callableByAgent
   * gate — the trigger binding is the gate). Reentrancy-guarded: while one hook run is
   * in flight, further hook runs are skipped so a workflow that edits files can't loop.
   */
  async runForHook(
    workflowId: string,
    input: unknown,
    workspaceOverride?: string
  ): Promise<{ ok: boolean; status: WorkflowRunStatus; message: string; output: string; runId: string; skipped: boolean }> {
    if (this.hookRunActive) {
      return { ok: true, status: 'success', message: 'skipped (hook already running)', output: '', runId: '', skipped: true }
    }
    const settings = await this.deps.store.load()
    const workflow = settings.workflow.workflows.find((item) => item.id === workflowId)
    if (!workflow) {
      return { ok: false, status: 'error', message: `Hook workflow "${workflowId}" not found.`, output: '', runId: '', skipped: false }
    }
    this.hookRunActive = true
    try {
      const result = await this.runResolved(workflow, input, workspaceOverride)
      return { ...result, skipped: false }
    } finally {
      this.hookRunActive = false
    }
  }

  /** Run any workflow by id or name (no callableByAgent gate) — for the local POST /workflow/run API. */
  async runWorkflowByRef(
    idOrName: string,
    input?: unknown,
    workspaceOverride?: string
  ): Promise<{ ok: boolean; status: WorkflowRunStatus; message: string; output: string; runId: string }> {
    const settings = await this.deps.store.load()
    const lower = idOrName.toLowerCase()
    const workflow = settings.workflow.workflows.find(
      (item) => item.enabled && (item.id === idOrName || item.name.toLowerCase() === lower)
    )
    if (!workflow) {
      return {
        ok: false,
        status: 'error',
        message: `No enabled workflow matches "${idOrName}". Enable the workflow to expose it over HTTP.`,
        output: '',
        runId: ''
      }
    }
    return this.runResolved(workflow, input, workspaceOverride)
  }

  private async runResolved(
    workflow: WorkflowV1,
    input: unknown,
    workspaceOverride?: string
  ): Promise<{ ok: boolean; status: WorkflowRunStatus; message: string; output: string; runId: string }> {
    if (this.runCoordinator.isRunning(workflow.id)) {
      return { ok: false, status: 'error', message: 'Workflow is already running.', output: '', runId: '' }
    }
    // Prefer an enabled trigger (manual > schedule > webhook); fall back to any trigger.
    const trigger = selectWorkflowTrigger(workflow, true) ?? selectWorkflowTrigger(workflow)
    if (!trigger) {
      return { ok: false, status: 'error', message: 'Workflow has no trigger node.', output: '', runId: '' }
    }
    const inputSchema = trigger.type === 'manual-trigger' ? trigger.config.inputSchema : undefined
    const missing = missingRequiredInput(inputSchema, input)
    if (missing) {
      return { ok: false, status: 'error', message: `Missing required input: ${missing}`, output: '', runId: '' }
    }
    const runId = randomUUID()
    const initialPayload = coerceInputToPayload(inputSchema, input)
    const result = await this.runWorkflowInternal(workflow, trigger.id, 'agent', runId, initialPayload, workspaceOverride)
    const after = await this.deps.store.load()
    const run = after.workflow.workflows.find((item) => item.id === workflow.id)?.runs.find((entry) => entry.id === runId)
    const status: WorkflowRunStatus = 'status' in result ? result.status : 'error'
    const output = this.pickRunOutput(workflow, run) || result.message
    return { ok: result.ok, status, message: result.message, output, runId }
  }

  /** The run's canonical output: the last successful `output` node's result, else the last node's. */
  private pickRunOutput(workflow: WorkflowV1, run: WorkflowRunV1 | undefined): string {
    if (!run) return ''
    const outputIds = new Set(workflow.nodes.filter((node) => node.type === 'output').map((node) => node.id))
    const fromOutput = [...run.nodeResults]
      .reverse()
      .find((entry) => outputIds.has(entry.nodeId) && entry.status === 'success')
    const chosen = fromOutput ?? run.nodeResults[run.nodeResults.length - 1]
    return chosen?.outputJson ?? ''
  }

  async status(): Promise<WorkflowRuntimeStatus> {
    return this.runCoordinator.status(this.isPowerSaveBlockerActive())
  }

  /** Resolve a paused human-approval node. Returns false if the token is unknown (e.g. already decided). */
  resolveApproval(token: string, decision: WorkflowApprovalDecision): boolean {
    return this.runCoordinator.resolveApproval(token, decision)
  }

  async runWorkflow(workflowId: string, input?: unknown): Promise<WorkflowRunResult> {
    const settings = await this.deps.store.load()
    const workflow = settings.workflow.workflows.find((item) => item.id === workflowId)
    if (!workflow) return { ok: false, message: 'Workflow not found.' }
    if (this.runCoordinator.isRunning(workflowId)) return { ok: false, message: 'Workflow is already running.' }
    const trigger = selectWorkflowTrigger(workflow)
    if (!trigger) return { ok: false, message: 'Workflow has no trigger node.' }
    const inputSchema = trigger.type === 'manual-trigger' ? trigger.config.inputSchema : undefined
    const missing = missingRequiredInput(inputSchema, input)
    if (missing) return { ok: false, message: `Missing required input: ${missing}` }
    const runId = randomUUID()
    const initialPayload = coerceInputToPayload(inputSchema, input)
    // Fire-and-poll: the UI watches status() for per-node progress.
    void this.runWorkflowInternal(workflow, trigger.id, 'manual', runId, initialPayload)
    return { ok: true, runId, status: 'running', message: 'Started' }
  }

  async stopWorkflow(workflowId: string): Promise<WorkflowRunResult> {
    if (!this.runCoordinator.requestCancel(workflowId)) return { ok: false, message: 'Workflow is not running.' }
    return { ok: true, runId: '', status: 'running', message: 'Stopping' }
  }

  async runSingleNode(workflowId: string, nodeId: string): Promise<WorkflowRunResult> {
    const settings = await this.deps.store.load()
    const workflow = settings.workflow.workflows.find((item) => item.id === workflowId)
    if (!workflow) return { ok: false, message: 'Workflow not found.' }
    const node = workflow.nodes.find((item) => item.id === nodeId)
    if (!node) return { ok: false, message: 'Node not found.' }
    const runId = randomUUID()
    void (async () => {
      const live = this.runCoordinator.beginSingleNode(workflowId, nodeId)
      try {
        await this.executeNode(node, { json: {}, text: '' }, settings, undefined, 0, resolveRunWorkspace(workflow, settings))
        live.set(nodeId, 'success')
      } catch {
        live.set(nodeId, 'error')
      } finally {
        this.runCoordinator.finishSingleNode(workflowId, LIVE_STATUS_LINGER_MS)
      }
    })()
    return { ok: true, runId, status: 'running', message: 'Started' }
  }

  /** Run a single node in isolation against a mock upstream payload, returning its result (not persisted). */
  async testNode(workflowId: string, nodeId: string, mockJson: string): Promise<WorkflowNodeTestResult> {
    const settings = await this.deps.store.load()
    const workflow = settings.workflow.workflows.find((item) => item.id === workflowId)
    if (!workflow) return { ok: false, message: 'Workflow not found.' }
    const node = workflow.nodes.find((item) => item.id === nodeId)
    if (!node) return { ok: false, message: 'Node not found.' }
    if (node.type.endsWith('-trigger')) return { ok: false, message: 'Trigger nodes cannot be tested.' }

    let mockValue: unknown = {}
    const trimmed = mockJson.trim()
    if (trimmed) {
      try {
        mockValue = JSON.parse(trimmed)
      } catch {
        mockValue = trimmed
      }
    }
    const payload: WorkflowPayload = {
      json: mockValue,
      text: typeof mockValue === 'string' ? mockValue : safeJson(mockValue)
    }
    const env = resolveEnv(workflow.env)
    const secretValues = workflow.env
      .filter((entry) => entry.type === 'secret' && entry.value.trim())
      .map((entry) => entry.value)
    const redact = (text: string): string => secretValues.reduce((acc, secret) => acc.split(secret).join('***'), text)
    const scope: InterpScope = { nodes: {}, env, run: {} }
    const startedAt = new Date()
    const inputJson = redact(safeJson(payload.json))
    try {
      const outcome = await this.executeNode(
        node,
        payload,
        settings,
        [payload],
        0,
        resolveRunWorkspace(workflow, settings),
        scope,
        {}
      )
      return {
        ok: true,
        result: {
          nodeId,
          status: 'success',
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          message: redact(outcome.message),
          outputJson: redact(safeJson(outcome.payload.json)),
          inputJson,
          retries: 0,
          threadId: outcome.threadId ?? '',
          error: ''
        }
      }
    } catch (error) {
      return {
        ok: true,
        result: {
          nodeId,
          status: 'error',
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          message: '',
          outputJson: '',
          inputJson,
          retries: 0,
          threadId: '',
          error: redact(error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  private startScheduler(): void {
    this.scheduler.start()
  }

  private async tick(): Promise<void> {
    const settings = await this.deps.store.load()
    if (!settings.workflow.enabled) return
    await this.ensureNextRuns(settings)
    const fresh = await this.deps.store.load()
    const now = Date.now()
    for (const workflow of fresh.workflow.workflows) {
      if (!workflow.enabled || this.runCoordinator.isRunning(workflow.id)) continue
      const trigger = activeScheduleTriggers(workflow)[0]
      if (!trigger) continue
      const dueAt = Date.parse(workflow.nextRunAt)
      if (!Number.isFinite(dueAt) || dueAt > now) continue
      void this.runWorkflowInternal(workflow, trigger.id, 'schedule')
    }
  }

  private async ensureNextRuns(settings: AppSettingsV1): Promise<void> {
    if (!settings.workflow.enabled) {
      this.syncPowerSaveBlocker(settings)
      return
    }
    let changed = false
    const now = new Date()
    const workflows = settings.workflow.workflows.map((workflow) => {
      const wasInterrupted = workflow.lastStatus === 'running' && !this.runCoordinator.isRunning(workflow.id)
      const scheduled = workflowHasScheduleTrigger(workflow)
      if (!workflow.enabled || !scheduled || this.runCoordinator.isRunning(workflow.id)) {
        if (!wasInterrupted) return workflow
        changed = true
        return {
          ...workflow,
          lastStatus: 'error' as const,
          lastMessage: 'Workflow was interrupted before completion.',
          updatedAt: now.toISOString()
        }
      }
      if (workflow.nextRunAt && !wasInterrupted) return workflow
      changed = true
      return {
        ...workflow,
        nextRunAt: computeWorkflowNextRunAt(workflow, now),
        ...(wasInterrupted
          ? {
              lastStatus: 'error' as const,
              lastMessage: 'Workflow was interrupted before completion.',
              updatedAt: now.toISOString()
            }
          : {})
      }
    })
    if (!changed) {
      this.syncPowerSaveBlocker(settings)
      return
    }
    const saved = await this.deps.store.patch({ workflow: { ...settings.workflow, workflows } })
    this.syncPowerSaveBlocker(saved)
  }

  private updateWorkflow(
    workflowId: string,
    updater: (workflow: WorkflowV1) => WorkflowV1
  ): Promise<AppSettingsV1> {
    const update = this.workflowUpdateTail.then(async () => {
      const settings = await this.deps.store.load()
      const workflows = settings.workflow.workflows.map((workflow) =>
        workflow.id === workflowId ? updater(workflow) : workflow
      )
      const saved = await this.deps.store.patch({ workflow: { ...settings.workflow, workflows } })
      this.syncPowerSaveBlocker(saved)
      return saved
    })
    this.workflowUpdateTail = update.then(() => undefined, () => undefined)
    return update
  }

  private setLive(workflowId: string, nodeId: string, status: WorkflowNodeRunStatus): void {
    this.runCoordinator.setLive(workflowId, nodeId, status)
  }

  /** Surface a per-node result (input/output/timing) live so the editor can show run logs as it runs. */
  private setLiveResult(workflowId: string | undefined, result: WorkflowNodeRunResultV1): void {
    this.runCoordinator.setLiveResult(workflowId, result)
  }

  private async runWorkflowInternal(
    workflow: WorkflowV1,
    triggerNodeId: string,
    triggerLabel: string,
    runId = randomUUID(),
    initialPayload: WorkflowPayload = { json: {}, text: '' },
    workspaceOverride?: string
  ): Promise<WorkflowRunResult> {
    if (this.runCoordinator.isRunning(workflow.id)) {
      return { ok: false, message: 'Workflow is already running.' }
    }
    this.runCoordinator.begin(workflow.id, workflow.nodes.map((node) => node.id))

    const startedAt = new Date()
    const run: WorkflowRunV1 = {
      id: runId,
      trigger: triggerLabel,
      status: 'running',
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      message: '',
      nodeResults: []
    }
    await this.updateWorkflow(workflow.id, (current) => ({
      ...current,
      lastStatus: 'running',
      lastMessage: 'Running',
      nextRunAt: '',
      updatedAt: startedAt.toISOString(),
      runs: [...current.runs, run].slice(-MAX_WORKFLOW_RUNS)
    }))

    let runStatus: WorkflowRunStatus = 'success'
    let runMessage = ''
    let nodeResults: WorkflowNodeRunResultV1[] = []
    try {
      const settings = await this.deps.store.load()
      const result = await this.runGraph(workflow, triggerNodeId, initialPayload, {
        settings,
        statusWorkflowId: workflow.id,
        cancelId: workflow.id,
        runId,
        depth: 0,
        workspaceOverride
      })
      runStatus = result.status
      nodeResults = result.nodeResults
      runMessage = runStatus === 'success' ? summarizeRun(nodeResults) : result.errorMessage
    } catch (error) {
      runStatus = 'error'
      runMessage = error instanceof Error ? error.message : String(error)
      this.deps.logError('workflow', 'Workflow run failed', { message: runMessage, workflowId: workflow.id })
    } finally {
      const finishedAt = new Date()
      await this.updateWorkflow(workflow.id, (current) => ({
        ...current,
        lastRunAt: finishedAt.toISOString(),
        lastStatus: runStatus,
        lastMessage: runMessage,
        nextRunAt: computeWorkflowNextRunAt(current, finishedAt),
        updatedAt: finishedAt.toISOString(),
        runs: current.runs.map((entry) =>
          entry.id === runId
            ? { ...entry, status: runStatus, finishedAt: finishedAt.toISOString(), message: runMessage, nodeResults }
            : entry
        )
      }))
      this.runCoordinator.finish(workflow.id, runId, LIVE_STATUS_LINGER_MS)
    }
    return { ok: runStatus !== 'error', runId, status: runStatus, message: runMessage }
  }

  /**
   * Pruning dataflow scheduler over one workflow graph. A node runs once all its
   * incoming edges are resolved (delivered a payload, or pruned). Conditions /
   * switches prune the branches they don't take, cascading to make downstream
   * nodes unreachable — so joins (Merge) wait only for branches that fire.
   * Pure: no persistence. Used by both top-level runs and sub-workflow nodes.
   */
  private async runGraph(
    workflow: WorkflowV1,
    triggerNodeId: string,
    initialPayload: WorkflowPayload,
    ctx: {
      settings: AppSettingsV1
      statusWorkflowId?: string
      cancelId?: string
      /** Run id, for keying human-approval pauses to this run. */
      runId?: string
      depth: number
      workspaceOverride?: string
      /** Loop frame for body sub-runs, exposed via {{$loop.*}}. */
      loop?: { index: number; item: unknown; total: number }
      /** Run-scoped vars shared across the run (set-fields scope=run). */
      runVars?: Record<string, unknown>
    }
  ): Promise<{
    status: WorkflowRunStatus
    errorMessage: string
    nodeResults: WorkflowNodeRunResultV1[]
    output: WorkflowPayload
  }> {
    const { settings } = ctx
    const env = resolveEnv(workflow.env)
    const runVars = ctx.runVars ?? {}
    // The trigger's working directory can read the run input ({{json.dir}}), so a
    // caller can pass the working directory in as a run parameter.
    const runWorkspace =
      ctx.workspaceOverride?.trim() ||
      resolveRunWorkspace(workflow, settings, triggerNodeId, initialPayload, { env, run: runVars, loop: ctx.loop })
    const setLive = (nodeId: string, status: WorkflowNodeRunStatus): void => {
      if (ctx.statusWorkflowId) this.setLive(ctx.statusWorkflowId, nodeId, status)
    }
    const isCanceled = (): boolean => this.runCoordinator.isCanceled(ctx.cancelId)

    const planned = createWorkflowExecutionPlan(workflow, triggerNodeId)
    if (!planned.ok) {
      return { status: 'error', errorMessage: planned.error, nodeResults: [], output: initialPayload }
    }
    const nodeById = planned.plan.nodeById
    const outEdges = planned.plan.outgoingByNodeId
    const inEdges = planned.plan.incomingByNodeId

    const nodeResults: WorkflowNodeRunResultV1[] = []
    const delivered = new Set<string>()
    const prunedEdges = new Set<string>()
    const payloadByEdge = new Map<string, WorkflowPayload>()
    const settledNodes = new Set<string>()
    const readyQueue: string[] = []
    const deadline = Date.now() + MAX_RUN_DURATION_MS
    let executions = 0
    let status: WorkflowRunStatus = 'success'
    let errorMessage = ''
    let output = initialPayload

    // Interpolation scope shared across the run: completed-node outputs ($nodes),
    // workflow env ($env), run-scoped vars ($run), and the loop frame ($loop).
    const nodeOutputs: Record<string, WorkflowPayload> = {}
    // Global secret set so this run also masks secrets owned by sub-workflows / loop
    // bodies whose output or error flows back across the workflow boundary.
    const secretValues = collectSecretValues(settings)
    const redact = (text: string): string => redactSecrets(secretValues, text)
    const scopeFor = (): InterpScope => ({ nodes: nodeOutputs, env, run: runVars, loop: ctx.loop })

    const incoming = (nodeId: string): readonly WorkflowConnectionV1[] => inEdges.get(nodeId) ?? []
    const edgeResolved = (edge: WorkflowConnectionV1): boolean =>
      delivered.has(edge.id) || prunedEdges.has(edge.id)
    const allResolved = (nodeId: string): boolean => incoming(nodeId).every(edgeResolved)
    const hasLiveInput = (nodeId: string): boolean => incoming(nodeId).some((edge) => delivered.has(edge.id))
    const markReady = (nodeId: string): void => {
      if (!settledNodes.has(nodeId) && !readyQueue.includes(nodeId)) readyQueue.push(nodeId)
    }
    function pruneEdge(edge: WorkflowConnectionV1): void {
      if (delivered.has(edge.id) || prunedEdges.has(edge.id)) return
      prunedEdges.add(edge.id)
      settleTarget(edge.target)
    }
    function pruneNode(nodeId: string): void {
      if (settledNodes.has(nodeId)) return
      settledNodes.add(nodeId)
      for (const edge of outEdges.get(nodeId) ?? []) pruneEdge(edge)
    }
    function settleTarget(nodeId: string): void {
      if (settledNodes.has(nodeId) || !allResolved(nodeId)) return
      if (hasLiveInput(nodeId)) markReady(nodeId)
      else pruneNode(nodeId)
    }
    const handleActive = (outcome: NodeOutcome | null, sourceHandle: string): boolean => {
      if (!outcome || outcome.branch === undefined) return true
      return sourceHandle === outcome.branch
    }

    markReady(triggerNodeId)
    try {
      while (readyQueue.length > 0) {
        if (isCanceled()) {
          status = 'error'
          errorMessage = 'Canceled.'
          break
        }
        if (Date.now() > deadline) {
          status = 'error'
          errorMessage = 'Workflow exceeded the maximum run duration.'
          break
        }
        if (executions >= MAX_NODE_EXECUTIONS) {
          status = 'error'
          errorMessage = 'Workflow exceeded the maximum node count.'
          break
        }
        const nodeId = readyQueue.shift()
        if (!nodeId || settledNodes.has(nodeId)) continue
        const node = nodeById.get(nodeId)
        settledNodes.add(nodeId)
        if (!node) continue
        executions += 1

        const inputs = incoming(nodeId)
          .filter((edge) => delivered.has(edge.id))
          .map((edge) => payloadByEdge.get(edge.id))
          .filter((value): value is WorkflowPayload => Boolean(value))
        const primary = inputs[0] ?? (nodeId === triggerNodeId ? initialPayload : { json: {}, text: '' })

        let outcome: NodeOutcome | null
        if (node.disabled) {
          setLive(node.id, 'skipped')
          outcome = null
        } else {
          setLive(node.id, 'running')
          const nodeStartedAt = new Date()
          const inputJson = redact(safeJson(primary.json))
          // Surface the input immediately so the run log shows it while the node runs.
          this.setLiveResult(ctx.statusWorkflowId, {
            nodeId: node.id,
            status: 'running',
            startedAt: nodeStartedAt.toISOString(),
            finishedAt: '',
            message: '',
            outputJson: '',
            inputJson,
            retries: 0,
            threadId: '',
            error: ''
          })
          const maxRetries = node.retries ?? 0
          let attempt = 0
          let produced: NodeOutcome | null = null
          let lastError = ''
          // Retry, then apply onError: 'fail' (default) stops the run; 'continue'/'fallback' resume.
          while (true) {
            try {
              const baseScope = scopeFor()
              const nodeInputs = resolveNodeInputs(node, primary, baseScope)
              produced = await this.executeNode(
                node,
                primary,
                settings,
                inputs.length ? inputs : [primary],
                ctx.depth,
                runWorkspace,
                nodeInputs ? { ...baseScope, input: nodeInputs } : baseScope,
                runVars,
                ctx.statusWorkflowId && ctx.runId
                  ? { workflowId: ctx.statusWorkflowId, runId: ctx.runId }
                  : undefined
              )
              break
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error)
              if (attempt < maxRetries) {
                attempt += 1
                if (node.retryDelayMs) await sleep(node.retryDelayMs)
                continue
              }
              const mode = node.onError ?? 'fail'
              if (mode === 'continue' || mode === 'fallback') {
                let fallback: unknown = null
                if (mode === 'fallback' && node.fallbackJson) {
                  try {
                    fallback = JSON.parse(node.fallbackJson)
                  } catch {
                    fallback = node.fallbackJson
                  }
                }
                produced = {
                  payload: { json: fallback, text: mode === 'fallback' ? safeJson(fallback) : '' },
                  message: `error handled (${mode}): ${lastError}`
                }
              }
              break
            }
          }
          if (produced) {
            const result: WorkflowNodeRunResultV1 = {
              nodeId: node.id,
              status: 'success',
              startedAt: nodeStartedAt.toISOString(),
              finishedAt: new Date().toISOString(),
              message: redact(produced.message),
              outputJson: redact(safeJson(produced.payload.json)),
              inputJson,
              retries: attempt,
              threadId: produced.threadId ?? '',
              error: lastError ? redact(lastError) : ''
            }
            nodeResults.push(result)
            this.setLiveResult(ctx.statusWorkflowId, result)
            setLive(node.id, 'success')
            outcome = produced
            output = produced.payload
            nodeOutputs[node.id] = produced.payload
          } else {
            const result: WorkflowNodeRunResultV1 = {
              nodeId: node.id,
              status: 'error',
              startedAt: nodeStartedAt.toISOString(),
              finishedAt: new Date().toISOString(),
              message: '',
              outputJson: '',
              inputJson,
              retries: attempt,
              threadId: '',
              error: redact(lastError)
            }
            nodeResults.push(result)
            this.setLiveResult(ctx.statusWorkflowId, result)
            setLive(node.id, 'error')
            status = 'error'
            errorMessage = redact(lastError)
            break
          }
        }

        const outPayload = outcome ? outcome.payload : primary
        const edges = outEdges.get(node.id) ?? []
        for (const edge of edges) {
          if (handleActive(outcome, edge.sourceHandle || 'out')) {
            delivered.add(edge.id)
            payloadByEdge.set(edge.id, outPayload)
          } else {
            prunedEdges.add(edge.id)
          }
        }
        for (const edge of edges) settleTarget(edge.target)
      }
    } catch (error) {
      status = 'error'
      errorMessage = redact(error instanceof Error ? error.message : String(error))
      this.deps.logError('workflow', 'Workflow graph failed', { message: errorMessage, workflowId: workflow.id })
    }

    return { status, errorMessage, nodeResults, output }
  }

  private async executeNode(
    node: WorkflowNodeV1,
    payload: WorkflowPayload,
    settings: AppSettingsV1,
    inputs: WorkflowPayload[] = [payload],
    depth = 0,
    runWorkspace = '',
    scope: InterpScope = {},
    runVars: Record<string, unknown> = {},
    runRef?: { workflowId: string; runId: string }
  ): Promise<NodeOutcome> {
    const context: NodeExecutionContext = {
      payload,
      settings,
      inputs,
      depth,
      runWorkspace,
      scope,
      runVars,
      runRef
    }
    return this.nodeExecutors.execute(node, {
      executeCore: (registeredNode) => this.executeCoreNode(registeredNode, context),
      executeAi: (registeredNode) => this.executeAiNode(registeredNode, context),
      executeImage: (registeredNode) => this.executeImageNode(registeredNode, context),
      executeCode: (registeredNode) => this.executeCodeNode(registeredNode, context),
      executeNested: (registeredNode) => this.executeNestedNode(registeredNode, context),
      executeHttp: (registeredNode) => this.executeHttpNode(registeredNode, context),
      executeApproval: (registeredNode) => this.executeApprovalNode(registeredNode, context),
      executeCustom: (registeredNode) => this.executeCustomNode(registeredNode, context)
    })
  }

  private async executeCoreNode(
    node: WorkflowNodeV1,
    context: NodeExecutionContext
  ): Promise<NodeOutcome> {
    if (!isCoreWorkflowNode(node)) {
      throw new Error(`Core workflow node adapter received unsupported kind: ${node.type}`)
    }
    const coreOutcome = await executeCoreWorkflowNode({
      node,
      payload: context.payload,
      inputs: context.inputs,
      scope: context.scope,
      runVars: context.runVars,
      sleep
    })
    if (coreOutcome) return coreOutcome
    throw new Error(`Core workflow node adapter returned no outcome: ${node.type}`)
  }

  private executeAiNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'ai-agent' && node.type !== 'parameter-extractor' && node.type !== 'question-classifier') {
      throw new Error(`AI workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeAiWorkflowNode({
      node,
      payload: context.payload,
      settings: context.settings,
      deps: this.deps,
      runWorkspace: context.runWorkspace,
      scope: context.scope
    })
  }

  private executeImageNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'generate-image') {
      throw new Error(`Image workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeImageWorkflowNode({
      node,
      payload: context.payload,
      settings: context.settings,
      runWorkspace: context.runWorkspace,
      scope: context.scope
    })
  }

  private executeCodeNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'code') {
      throw new Error(`Code workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeCodeWorkflowNode({ node, payload: context.payload })
  }

  private async executeNestedNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    const { depth, payload, scope, settings } = context
    switch (node.type) {
      case 'subworkflow': {
        if (depth >= MAX_SUBWORKFLOW_DEPTH) throw new Error('Sub-workflow nesting is too deep.')
        const target = settings.workflow.workflows.find((workflow) => workflow.id === node.config.workflowId)
        if (!target) throw new Error('Sub-workflow not found.')
        const trigger =
          target.nodes.find((item) => item.type === 'manual-trigger') ??
          target.nodes.find((item) => item.type === 'schedule-trigger')
        if (!trigger) throw new Error('Sub-workflow has no trigger node.')
        const result = await this.runGraph(target, trigger.id, payload, { settings, depth: depth + 1 })
        if (result.status === 'error') throw new Error(result.errorMessage || 'Sub-workflow failed.')
        return { payload: result.output, message: `ran ${target.name || 'sub-workflow'}` }
      }
      case 'loop': {
        if (depth >= MAX_SUBWORKFLOW_DEPTH) throw new Error('Loop nesting is too deep.')
        const target = settings.workflow.workflows.find((workflow) => workflow.id === node.config.workflowId)
        if (!target) throw new Error('Loop body workflow not found.')
        const trigger =
          target.nodes.find((item) => item.type === 'manual-trigger') ??
          target.nodes.find((item) => item.type === 'schedule-trigger') ??
          target.nodes.find((item) => item.type === 'webhook-trigger')
        if (!trigger) throw new Error('Loop body has no trigger node.')
        if (node.config.mode === 'foreach') {
          // for-each: iterate an array, running the body once per item, optionally
          // in parallel. Each iteration sees $loop.index / $loop.item / $loop.total.
          const source = node.config.arraySource?.trim()
          const raw = source ? resolveExpr(payload, source, scope) : payload.json
          const items = (Array.isArray(raw) ? raw : []).slice(0, node.config.maxIterations)
          const total = items.length
          // Fail-fast: once one iteration throws (and we're not collecting errors),
          // short-circuit pending iterations so parallel workers stop launching new sub-runs.
          let aborted = false
          const runItem = async (item: unknown, index: number): Promise<unknown> => {
            if (aborted) throw new Error('Loop aborted after an earlier item failed.')
            const itemPayload: WorkflowPayload = {
              json: item,
              text: typeof item === 'string' ? item : safeJson(item)
            }
            try {
              const result = await this.runGraph(target, trigger.id, itemPayload, {
                settings,
                depth: depth + 1,
                loop: { index, item, total }
              })
              if (result.status === 'error') throw new Error(result.errorMessage || 'Loop item failed.')
              return result.output.json
            } catch (error) {
              if (node.config.continueOnError) return { error: error instanceof Error ? error.message : String(error) }
              aborted = true
              throw error
            }
          }
          const outputs =
            node.config.execution === 'parallel'
              ? await mapWithConcurrency(items, node.config.concurrency ?? 4, runItem)
              : await (async (): Promise<unknown[]> => {
                  const acc: unknown[] = []
                  for (let index = 0; index < items.length; index += 1) acc.push(await runItem(items[index], index))
                  return acc
                })()
          const failures = outputs.filter(
            (value) => value && typeof value === 'object' && 'error' in (value as Record<string, unknown>)
          ).length
          return {
            payload: { json: outputs, text: safeJson(outputs) },
            message: `foreach ${total - failures}/${total}${node.config.execution === 'parallel' ? ' (parallel)' : ''}`
          }
        }
        const stopCondition = {
          leftExpr: node.config.leftExpr,
          operator: node.config.operator,
          rightValue: node.config.rightValue,
          caseSensitive: node.config.caseSensitive
        }
        // Loop agent: run the body, feed its output back in, until the stop
        // condition holds or maxIterations caps it.
        let current = payload
        let iterations = 0
        let done = false
        while (iterations < node.config.maxIterations) {
          const result = await this.runGraph(target, trigger.id, current, {
            settings,
            depth: depth + 1,
            loop: { index: iterations, item: current.json, total: node.config.maxIterations }
          })
          iterations += 1
          if (result.status === 'error') throw new Error(result.errorMessage || 'Loop body failed.')
          current = result.output
          if (evaluateCondition(stopCondition, current, scope)) {
            done = true
            break
          }
        }
        const baseJson =
          current.json && typeof current.json === 'object' && !Array.isArray(current.json)
            ? { ...(current.json as Record<string, unknown>) }
            : { value: current.json }
        return {
          payload: { json: { ...baseJson, _iterations: iterations, _done: done }, text: current.text },
          message: `looped ${iterations}${done ? ' (done)' : ' (max)'}`
        }
      }
      default:
        throw new Error(`Nested workflow node adapter received unsupported kind: ${node.type}`)
    }
  }

  private executeHttpNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'http-request') {
      throw new Error(`HTTP workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeHttpWorkflowNode(node.config, context.payload, context.scope)
  }

  private async executeApprovalNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'human-approval') {
      throw new Error(`Approval workflow node adapter received unsupported kind: ${node.type}`)
    }
    const { payload, runRef, scope, settings } = context
    // Pause the run until a decision arrives. Routes to the approved/rejected branch.
    // Note: the pending state is in-memory — an app restart mid-pause loses the run.
    if (!runRef) {
      // Single-node test / validation: cannot pause, so auto-approve.
      return { payload, message: 'approved (test)', branch: 'approved' }
    }
    const token = randomUUID()
    // Redact secrets: the instruction is surfaced via status() to the approval UI.
    const approvalSecrets = collectSecretValues(settings)
    const entry: WorkflowPendingApprovalV1 = {
      token,
      workflowId: runRef.workflowId,
      runId: runRef.runId,
      nodeId: node.id,
      nodeName: node.name,
      title: redactSecrets(approvalSecrets, node.config.title.trim() || node.name.trim() || 'Approval required'),
      instruction: redactSecrets(approvalSecrets, interpolate(node.config.instruction, payload, scope)),
      createdAt: new Date().toISOString()
    }
    const decision = await this.runCoordinator.awaitApproval(
      entry,
      node.config.timeoutMs,
      node.config.onTimeout
    )
    if (decision === 'rejected') return { payload, message: 'rejected', branch: 'rejected' }
    const approvedJson =
      payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)
        ? { ...(payload.json as Record<string, unknown>), _approved: true }
        : payload.json
    return { payload: { json: approvedJson, text: payload.text }, message: 'approved', branch: 'approved' }
  }

  private executeCustomNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'custom') {
      throw new Error(`Custom workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeCustomWorkflowNode({
      node,
      payload: context.payload,
      modules: context.settings.workflow.modules
    })
  }

  private syncPowerSaveBlocker(settings: AppSettingsV1): void {
    const shouldKeepAwake =
      settings.workflow.keepAwake && settings.workflow.enabled && hasEnabledScheduledWorkflow(settings)
    if (!shouldKeepAwake) {
      // Only release if the schedule runtime is not also keeping the app awake.
      if (!(settings.schedule.keepAwake && settings.schedule.enabled && hasEnabledScheduledTask(settings))) {
        this.stopPowerSaveBlocker()
      }
      return
    }
    if (this.isPowerSaveBlockerActive()) return
    const blocker = this.deps.powerSaveBlocker
    if (!blocker) return
    this.powerSaveBlockerId = blocker.start('prevent-app-suspension')
  }

  private stopPowerSaveBlocker(): void {
    const blocker = this.deps.powerSaveBlocker
    const id = this.powerSaveBlockerId
    this.powerSaveBlockerId = null
    if (!blocker || id == null) return
    try {
      if (blocker.isStarted(id)) blocker.stop(id)
    } catch (error) {
      this.deps.logError('workflow-power-save', 'Failed to stop power save blocker', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private isPowerSaveBlockerActive(): boolean {
    const blocker = this.deps.powerSaveBlocker
    const id = this.powerSaveBlockerId
    if (!blocker || id == null) return false
    try {
      return blocker.isStarted(id)
    } catch {
      return false
    }
  }
}

export function createWorkflowRuntime(deps: ScheduleRuntimeDeps): WorkflowRuntime {
  return new WorkflowRuntime(deps)
}
