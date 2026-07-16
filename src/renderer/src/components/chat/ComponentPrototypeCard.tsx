import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Clipboard,
  Code2,
  Copy,
  Loader2,
  Monitor,
  RefreshCw,
  Smartphone,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import type { ComponentPrototypeMetadata, ToolBlock } from '../../agent/types'
import { previewWorkspaceFile } from '../../lib/workspace-file-preview'
import { DesignHtmlPreviewHost } from '../design/DesignHtmlPreviewHost'

type ComponentPrototypeCardProps = {
  block: ToolBlock
  workspaceRoot: string
  onPrompt?: (prompt: string) => void
}

type PreviewMode = 'desktop' | 'mobile'

export function componentPrototypeFromBlock(block: ToolBlock): ComponentPrototypeMetadata | null {
  const value = block.meta?.componentPrototype
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) return null
  const profile = raw.profile === 'component-designer' ? 'component-designer' : undefined
  const producer = raw.producer === 'main-agent' || raw.producer === 'component-designer'
    ? raw.producer
    : profile === 'component-designer'
      ? 'component-designer'
      : undefined
  if (!producer || (producer === 'main-agent' && profile)) return null
  if (raw.status !== 'preparing' && raw.status !== 'running' && raw.status !== 'completed' && raw.status !== 'failed') {
    return null
  }
  const artifactId = typeof raw.artifactId === 'string' ? raw.artifactId.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath.trim().replaceAll('\\', '/') : ''
  const viewport = raw.viewport && typeof raw.viewport === 'object' && !Array.isArray(raw.viewport)
    ? raw.viewport as Record<string, unknown>
    : null
  if (!artifactId || !title || !relativePath || !viewport) return null
  if (
    !/^\.kun-design\/component-prototypes\/[^/]+\/prototype\.html$/i.test(relativePath)
    || relativePath.split('/').includes('..')
  ) return null
  if (
    typeof viewport.width !== 'number'
    || !Number.isInteger(viewport.width)
    || viewport.width < 280
    || viewport.width > 1_200
    || typeof viewport.height !== 'number'
    || !Number.isInteger(viewport.height)
    || viewport.height < 240
    || viewport.height > 900
  ) return null
  return {
    version: 1,
    status: raw.status,
    artifactId,
    title,
    relativePath,
    viewport: { width: viewport.width, height: viewport.height },
    producer,
    ...(producer === 'component-designer' ? { profile: 'component-designer' as const } : {}),
    ...(typeof raw.childId === 'string' && raw.childId.trim() ? { childId: raw.childId.trim() } : {}),
    ...(typeof raw.byteSize === 'number' && Number.isInteger(raw.byteSize) && raw.byteSize >= 0
      ? { byteSize: raw.byteSize }
      : {}),
    ...(typeof raw.contentHash === 'string' && /^[a-f0-9]{64}$/i.test(raw.contentHash)
      ? { contentHash: raw.contentHash.toLowerCase() }
      : {}),
    ...(typeof raw.summary === 'string' && raw.summary.trim() ? { summary: raw.summary.trim() } : {}),
    ...(typeof raw.error === 'string' && raw.error.trim() ? { error: raw.error.trim() } : {})
  }
}

export function componentPrototypeFrameSize(
  prototype: ComponentPrototypeMetadata,
  mode: PreviewMode
): { width: number | '100%'; height: number } {
  if (mode === 'mobile') return { width: Math.min(390, prototype.viewport.width), height: Math.min(620, Math.max(420, prototype.viewport.height)) }
  return { width: '100%', height: Math.min(560, Math.max(320, prototype.viewport.height)) }
}

export function componentPrototypeFollowUpPrompt(
  prototype: ComponentPrototypeMetadata,
  action: 'adopt' | 'iterate',
  language = 'zh'
): string {
  if (!language.toLowerCase().startsWith('zh')) {
    if (action === 'adopt') {
      return `Adopt the “${prototype.title}” interaction prototype from this conversation (${prototype.relativePath}) and apply its confirmed interaction and visual states to the existing component. Check the current component boundary first and preserve the project's design language.`
    }
    return `Continue adjusting the “${prototype.title}” interaction prototype from this conversation (${prototype.relativePath}). I want to change: `
  }
  if (action === 'adopt') {
    return `请采纳会话中的「${prototype.title}」交互稿（${prototype.relativePath}），把确认后的交互和视觉状态应用到现有组件代码。实现前先核对现有组件边界，并保留项目当前设计语言。`
  }
  return `请继续调整会话中的「${prototype.title}」交互稿（${prototype.relativePath}）。我希望修改：`
}

function componentPrototypePartition(blockId: string): string {
  const safe = blockId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'prototype'
  return `kun-component-prototype-${safe}`
}

export function ComponentPrototypeCard({
  block,
  workspaceRoot,
  onPrompt
}: ComponentPrototypeCardProps): ReactElement | null {
  const { t, i18n } = useTranslation('common')
  const prototype = useMemo(() => componentPrototypeFromBlock(block), [block])
  const [mode, setMode] = useState<PreviewMode>('desktop')
  const [mountNonce, setMountNonce] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  if (!prototype) return null

  const running = prototype.status === 'preparing' || prototype.status === 'running'
  const failed = prototype.status === 'failed' || block.status === 'error'
  const frame = componentPrototypeFrameSize(prototype, mode)
  const producerLabel = prototype.producer === 'main-agent'
    ? t('componentPrototypeMainAgent')
    : t('componentPrototypeSubagent')
  const producerSummary = prototype.producer === 'main-agent'
    ? t('componentPrototypeGeneratedByMainAgent')
    : t('componentPrototypeGeneratedBy')
  const prompt = (action: 'adopt' | 'iterate'): void => {
    onPrompt?.(componentPrototypeFollowUpPrompt(
      prototype,
      action,
      i18n.resolvedLanguage || i18n.language
    ))
  }
  const inspectCode = (): void => {
    previewWorkspaceFile({ path: prototype.relativePath, workspaceRoot })
  }
  const copyCode = async (): Promise<void> => {
    if (typeof window.kunGui?.readWorkspaceFile !== 'function') {
      setCopyState('error')
      return
    }
    const result = await window.kunGui.readWorkspaceFile({ path: prototype.relativePath, workspaceRoot })
      .catch(() => ({ ok: false as const, message: 'read failed' }))
    if (!result.ok) {
      setCopyState('error')
      return
    }
    try {
      await navigator.clipboard.writeText(result.content)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    } catch {
      setCopyState('error')
    }
  }

  return (
    <article
      className="ds-component-prototype-card w-full min-w-0 overflow-hidden rounded-[16px] border border-ds-border bg-ds-card/95 shadow-[0_14px_40px_rgba(36,68,112,0.08)]"
      data-component-prototype-id={prototype.artifactId}
    >
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-ds-border-muted px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent/12 text-accent">
            <Sparkles className="h-4 w-4" strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="truncate text-[14px] font-semibold text-ds-ink">{prototype.title}</h3>
              <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
                {producerLabel}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-ds-faint">{prototype.relativePath}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span
            className={`mr-1 inline-flex items-center gap-1.5 text-[11.5px] font-medium ${
              failed ? 'text-rose-600 dark:text-rose-300' : running ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'
            }`}
          >
            {failed ? (
              <TriangleAlert className="h-3.5 w-3.5" />
            ) : running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
            )}
            {failed
              ? t('componentPrototypeFailed')
              : running
                ? t('componentPrototypeDesigning')
                : t('componentPrototypeInteractive')}
          </span>
          <div className="inline-flex rounded-lg border border-ds-border-muted bg-ds-subtle p-0.5">
            <button
              type="button"
              className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition ${mode === 'desktop' ? 'bg-ds-card text-accent shadow-sm' : 'text-ds-muted hover:text-ds-ink'}`}
              onClick={() => setMode('desktop')}
              aria-pressed={mode === 'desktop'}
              title={t('componentPrototypeDesktop')}
            >
              <Monitor className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('componentPrototypeDesktop')}</span>
            </button>
            <button
              type="button"
              className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition ${mode === 'mobile' ? 'bg-ds-card text-accent shadow-sm' : 'text-ds-muted hover:text-ds-ink'}`}
              onClick={() => setMode('mobile')}
              aria-pressed={mode === 'mobile'}
              title={t('componentPrototypeMobile')}
            >
              <Smartphone className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('componentPrototypeMobile')}</span>
            </button>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            onClick={() => setMountNonce((value) => value + 1)}
            title={t('componentPrototypeRefresh')}
            aria-label={t('componentPrototypeRefresh')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            onClick={() => void copyCode()}
            title={t('componentPrototypeCopyCode')}
            aria-label={t('componentPrototypeCopyCode')}
          >
            {copyState === 'copied' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : copyState === 'error' ? <TriangleAlert className="h-3.5 w-3.5 text-rose-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </header>

      <div className="flex min-h-[320px] justify-center overflow-auto bg-[radial-gradient(circle_at_center,rgba(111,132,165,0.18)_0.7px,transparent_0.8px)] bg-[length:16px_16px] p-3 sm:p-5">
        {failed ? (
          <div className="flex min-h-[300px] w-full items-center justify-center rounded-xl border border-rose-300/50 bg-ds-card/90 p-6 text-center dark:border-rose-800/50">
            <div className="max-w-lg">
              <TriangleAlert className="mx-auto h-7 w-7 text-rose-500" />
              <p className="mt-3 text-[13px] font-medium text-ds-ink">{t('componentPrototypeFailed')}</p>
              <p className="mt-1 break-words text-[12px] leading-5 text-ds-muted">{prototype.error || t('componentPrototypeLoadFailed')}</p>
            </div>
          </div>
        ) : (
          <div
            className="min-w-0 overflow-hidden rounded-xl border border-ds-border-muted bg-white shadow-[0_10px_30px_rgba(34,59,94,0.09)] transition-[width] duration-200"
            style={{ width: frame.width, height: frame.height, maxWidth: '100%' }}
          >
            <DesignHtmlPreviewHost
              key={`${block.id}:${mountNonce}`}
              workspaceRoot={workspaceRoot}
              relativePath={prototype.relativePath}
              enabled={Boolean(workspaceRoot)}
              partition={componentPrototypePartition(block.id)}
              retryMissingFile={running}
              mountWhileSkeleton
            >
              {({ state, renderWebview }) => {
                if (!state.webviewUrl) {
                  return (
                    <div className="flex h-full w-full items-center justify-center bg-[#f7f9fc] text-[12.5px] text-slate-500">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin text-accent" />
                      {state.error && !running ? state.error : t('componentPrototypeDesigning')}
                    </div>
                  )
                }
                return renderWebview({
                  className: 'h-full w-full border-0 bg-white',
                  style: { height: '100%', width: '100%' },
                  title: prototype.title
                })
              }}
            </DesignHtmlPreviewHost>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ds-border-muted px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-ds-faint">
          <span className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3" />{producerSummary}</span>
          <span aria-hidden>·</span>
          <span>HTML/CSS/JS</span>
          {prototype.byteSize !== undefined ? <><span aria-hidden>·</span><span>{Math.max(1, Math.round(prototype.byteSize / 1024))} KB</span></> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ds-border-muted px-3 text-[11.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            onClick={inspectCode}
          >
            <Code2 className="h-3.5 w-3.5" />
            {t('componentPrototypeViewCode')}
          </button>
          {onPrompt ? (
            <>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ds-border-muted px-3 text-[11.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
                onClick={() => prompt('iterate')}
                disabled={running || failed}
              >
                <Clipboard className="h-3.5 w-3.5" />
                {t('componentPrototypeIterate')}
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
                onClick={() => prompt('adopt')}
                disabled={running || failed}
              >
                <Check className="h-3.5 w-3.5" />
                {t('componentPrototypeAdopt')}
              </button>
            </>
          ) : null}
        </div>
      </footer>
    </article>
  )
}
