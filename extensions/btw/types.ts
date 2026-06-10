/**
 * Shared BTW custom message types.
 *
 * Logic extensions and visual presenters both import these stable identifiers.
 * Keep TUI rendering code out of this module.
 */

export const BTW_DISPLAY_TYPE = "btw-display";
export const BTW_PROMOTED_TYPE = "btw-promoted";

export interface BtwDisplayDetails {
  kind: string;
  topicId: string;
  title: string;
  status?: string;
}

export interface BtwPromotedDetails {
  topicId: string;
  title: string;
}
