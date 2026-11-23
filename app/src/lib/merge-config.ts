import type { ConfigExtension } from 'tailwind-merge'

// App-owned. List the class names of your own --app-* tokens here (text sizes, shadows, tracking, leading, radius,
// animate, container and spacing names, extra class groups) so cn() doesn't drop them next to a base class. Installed
// once, never updated.
// Inhouse's names from src/index.css, minus the ones ui-base's lib/utils.ts already registers.
export const appMergeConfig: ConfigExtension<string, string> = {
  extend: {
    theme: {
      text: ['hero', 'parent'],
      shadow: ['page-xs', 'page-sm', 'page-md', 'page-lg', 'page-xl', 'composer-focus', 'selected'],
      tracking: ['card', 'section', 'stat', 'heading', 'display', 'caps'],
      leading: ['figure', 'hero', 'title', 'heading', 'icon', 'card', 'note', 'menu', 'prose', 'reading'],
      radius: ['bar'],
      animate: ['ih-wind', 'mark-1', 'mark-2', 'mark-3', 'step-in', 'word-in'],
      // --container-* (w-, max-w-, columns-) and --spacing-* (min-h-, max-h-, inset, margins) names.
      container: ['sidebar', 'sidebar-rail', 'settings-nav', 'library-nav', 'today-column', 'chat-column', 'page-narrow', 'page-default', 'page-wide',
        'screen-gutter', 'screen-gutter-sm', 'menu-message', 'menu-attach', 'menu-tools', 'menu-mode', 'menu-mode-phone', 'menu-account', 'popover-notifications', 'select-menu', 'problem-panel', 'activity-panel', 'library',
        'window-sm', 'window-md', 'window-lg', 'window-xl', /* PR 5 */ 'prose-measure', 'answer-measure'],
      spacing: ['select-height', 'below-topbar', 'playhead', 'playhead-offset', 'activity-indent', 'time-column', 'run-when', 'bar-tick', 'today-top', 'chat-empty-top',
        'viewer-image', 'card-name', 'card-meta', 'today-status', 'toast', 'trace-label', 'safe-bottom', 'composer-input', 'window', 'window-sm', 'window-lg',
        'window-max', 'window-max-lg',
        /* PR 5 */ 'selection-room'],
      // Documentation only: tailwind-merge v3 already reads any text-, bg- or border- name as a colour.
      color: ['done', 'destructive-solid', 'on-destructive', 'switch-off', 'window-surface', 'tag-edge-strong', 'draft-sheet', 'draft-kind', 'success', 'success-tint', 'success-text', /* PR 5 */ 'bubble'],
    },
    // Groups whose names aren't theme scales in tailwind-merge. Without these, bg-dot-grid reads as a color and
    // border-hairline as a border color, and cn() drops one of two classes that don't conflict.
    classGroups: {
      'bg-image': [{ bg: ['topbar-fade', 'hatch-wait', 'hatch-approval', 'dot-grid', 'dot-grid-live', 'dot-grid-tool', 'sheet-fade'] }],
      'border-w': [{ border: ['hairline'] }],
      'grid-cols': [{ 'grid-cols': ['cards-sm', 'cards', 'cards-lg', 'cards-wide', 'library-list', 'usage-totals', 'trace-stats', 'trace'] }],
      // The stacking layers (--app-z-*): z has no theme scale in tailwind-merge.
      z: [{ z: ['raised', 'sidebar', 'composer', 'window-scrim', 'window', 'bar', 'trace-scrim', 'trace', 'confirm-scrim', 'confirm', 'toast', 'dev'] }],
    },
  },
}
