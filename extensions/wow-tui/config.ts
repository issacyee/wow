/**
 * Wow TUI configuration.
 *
 * Keep this small and static for now. User-facing configuration can be layered
 * on top later without changing the visual composition boundaries.
 */

export const WOW_TUI_CONFIG = {
  footer: true,
  editor: true,
  workflowWidgets: true,
  focusToolRendering: true,
  btwRendering: true,
} as const;
