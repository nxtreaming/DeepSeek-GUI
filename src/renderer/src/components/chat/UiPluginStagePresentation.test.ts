import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UiPluginPresentation } from '@shared/ui-plugin'
import { UiPluginStagePresentation } from './UiPluginStagePresentation'

const presentation: UiPluginPresentation = {
  character: {
    anchor: 'right',
    size: 'hero',
    offsetX: 2,
    offsetY: -1,
    opacity: 0.95,
    frame: 'crystal',
    motion: 'breathe',
    contentReserve: 'wide'
  },
  readability: { scrim: 'opposite-character', strength: 'medium' },
  surfaces: {
    sidebar: 'glass',
    topbar: 'glass',
    composer: 'strong-glass',
    cards: 'translucent'
  }
}

describe('UiPluginStagePresentation', () => {
  it('renders only the fixed inert host layers and validated portrait image', () => {
    const html = renderToStaticMarkup(
      createElement(UiPluginStagePresentation, {
        portraitSrc: 'data:image/png;base64,AAAA',
        presentation
      })
    )

    expect(html).toContain('class="ds-ui-plugin-decor-layer"')
    expect(html).toContain('class="ds-ui-plugin-character-layer"')
    expect(html).toContain('class="ds-ui-plugin-character"')
    expect(html).toContain('class="ds-ui-plugin-readability-scrim"')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain('alt=""')
    expect(html).toContain('draggable="false"')
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3)
    expect(html).not.toContain('<style')
    expect(html).not.toContain('dangerouslySetInnerHTML')
  })

  it('renders nothing unless both portrait and presentation are active', () => {
    expect(
      renderToStaticMarkup(
        createElement(UiPluginStagePresentation, { portraitSrc: null, presentation })
      )
    ).toBe('')
    expect(
      renderToStaticMarkup(
        createElement(UiPluginStagePresentation, {
          portraitSrc: 'data:image/png;base64,AAAA',
          presentation: null
        })
      )
    ).toBe('')
  })

  it('uses host-owned color primitives when presentation tokens may be gradients', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const css = await readFile(new URL('../../styles/surfaces-write.css', import.meta.url), 'utf8')
    expect(css).toContain('--kun-ui-plugin-host-bg-color: var(--bg-app, #f3f5fc);')
    expect(css).toContain('--kun-ui-plugin-host-surface-color: var(--surface-2, #ffffff);')
    expect(css).toContain('var(--kun-ui-plugin-host-bg-color) 0%')
    expect(css).not.toMatch(/color-mix\([^;]*var\(--ds-bg-main\)/)
    expect(css).not.toMatch(/color-mix\([^;]*var\(--ds-surface-elevated\)/)
  })
})
