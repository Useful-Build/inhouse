import type { CSSProperties } from 'react'
import type { IconName } from '@/components/ui/icon-names'
import { cn } from '@/lib/utils'

// The icon seam, owned by the app: ui-base's update leaves this file alone. Material Symbols draws by ligature, so
// each base name maps to itself. `satisfies` makes the type check fail when a ui-base release adds a name, until it's
// mapped here.
const BASE_ICONS = {
  check: 'check', chevron_right: 'chevron_right', close: 'close', expand_less: 'expand_less',
  expand_more: 'expand_more', search: 'search', unfold_more: 'unfold_more',
} satisfies Record<IconName, string>

/**
 * Material Symbols Rounded, the app's one icon set. Weight 300 by default; 400 for status glyphs and 14 px or smaller.
 * `name` stays a string: screens use many Material names beyond the base's seven.
 */
export function Icon({ name, size = 20, weight, fill, style, className }: {
  name: string; size?: number; weight?: number; fill?: boolean; style?: CSSProperties; className?: string
}) {
  const w = weight ?? (size <= 14 ? 400 : 300)
  return (
    <span aria-hidden="true" className={cn('ms', className)}
      style={{ fontSize: size, width: size, fontVariationSettings: `'wght' ${w}${fill ? ",'FILL' 1" : ''}`, ...style }}>
      {(BASE_ICONS as Record<string, string>)[name] ?? name}
    </span>
  )
}
