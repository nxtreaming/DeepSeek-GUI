import type { ReactElement } from 'react'
import type { UiPluginPresentation } from '@shared/ui-plugin'
import { useUiPluginStore } from '../../store/ui-plugin-store'

export type UiPluginStagePresentationProps = {
  portraitSrc: string | null
  presentation: UiPluginPresentation | null
}

/**
 * Fixed host markup for declarative character themes. The plugin contributes
 * only a main-process-validated image and normalized enum values; it cannot
 * contribute markup, event handlers, selectors, or executable code.
 */
export function UiPluginStagePresentation({
  portraitSrc,
  presentation
}: UiPluginStagePresentationProps): ReactElement | null {
  if (!portraitSrc || !presentation) return null

  return (
    <>
      <div className="ds-ui-plugin-decor-layer" aria-hidden="true" />
      <div className="ds-ui-plugin-character-layer" aria-hidden="true">
        <img
          className="ds-ui-plugin-character"
          src={portraitSrc}
          alt=""
          draggable={false}
          decoding="async"
        />
      </div>
      <div className="ds-ui-plugin-readability-scrim" aria-hidden="true" />
    </>
  )
}

export function ActiveUiPluginStagePresentation(): ReactElement | null {
  const runtime = useUiPluginStore((state) => state.activeRuntime)
  return (
    <UiPluginStagePresentation
      portraitSrc={runtime?.figures.portrait ?? null}
      presentation={runtime?.manifest.presentation ?? null}
    />
  )
}
