export function formatRelativeTime(input: string, locale: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return input
  }

  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const absSeconds = Math.abs(diffMs) / 1000
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (absSeconds < 60) {
    return formatRelativeUnit(formatter, locale, Math.round(diffMs / 1000), 'second')
  }

  const absMinutes = absSeconds / 60
  if (absMinutes < 60) {
    return formatRelativeUnit(formatter, locale, Math.round(diffMs / (60 * 1000)), 'minute')
  }

  const absHours = absMinutes / 60
  if (absHours < 24) {
    return formatRelativeUnit(formatter, locale, Math.round(diffMs / (60 * 60 * 1000)), 'hour')
  }

  const absDays = absHours / 24
  if (absDays < 7) {
    return formatRelativeUnit(formatter, locale, Math.round(diffMs / (24 * 60 * 60 * 1000)), 'day')
  }

  if (absDays < 30) {
    return formatRelativeUnit(formatter, locale, Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)), 'week')
  }

  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date)
}

type RelativeTimeUnit = Intl.RelativeTimeFormatUnit

function formatRelativeUnit(
  formatter: Intl.RelativeTimeFormat,
  locale: string,
  value: number,
  unit: RelativeTimeUnit
): string {
  const formatted = formatter.format(value, unit)
  if (value >= 0) {
    return formatted
  }

  return stripPastDirectionAffixes(formatter, value, unit) ?? formatted
}

function stripPastDirectionAffixes(
  formatter: Intl.RelativeTimeFormat,
  value: number,
  unit: RelativeTimeUnit
): string | null {
  const pastParts = formatter.formatToParts(value, unit)
  const futureParts = formatter.formatToParts(Math.abs(value), unit)
  const pastIntegerIndex = pastParts.findIndex((part) => part.type === 'integer')
  const futureIntegerIndex = futureParts.findIndex((part) => part.type === 'integer')

  if (pastIntegerIndex < 0 || futureIntegerIndex < 0) {
    return null
  }

  const integer = pastParts[pastIntegerIndex]?.value ?? ''
  const pastBefore = joinPartValues(pastParts.slice(0, pastIntegerIndex))
  const pastAfter = joinPartValues(pastParts.slice(pastIntegerIndex + 1))
  const futureBefore = joinPartValues(futureParts.slice(0, futureIntegerIndex))
  const futureAfter = joinPartValues(futureParts.slice(futureIntegerIndex + 1))
  const before = pastBefore === futureBefore ? pastBefore : ''
  const after = commonPrefix(pastAfter, futureAfter)
  const compact = `${before}${integer}${after}`.trim()

  return compact.length > 0 && compact !== integer ? compact : null
}

function joinPartValues(parts: Intl.RelativeTimeFormatPart[]): string {
  return parts.map((part) => part.value).join('')
}

function commonPrefix(first: string, second: string): string {
  const firstChars = Array.from(first)
  const secondChars = Array.from(second)
  const length = Math.min(firstChars.length, secondChars.length)
  let index = 0

  while (index < length && firstChars[index] === secondChars[index]) {
    index += 1
  }

  return firstChars.slice(0, index).join('')
}
