/**
 * Answer quality policy utilities.
 *
 * Prefix-cache rule: keep these instructions byte-stable. Do not add OS locale,
 * timestamps, random IDs, counters, or other transient data here.
 *
 * Note: the global answer-quality system-prompt block added in `ac82f04` has
 * been removed. The reminder below is used only by discuss mode in `strict`
 * level (see `wow/settings.ts` `wow.discussLevel`); it is self-contained and no
 * longer references a "global answer-quality policy".
 */

/**
 * Build a compact, self-contained reminder for discuss `strict` mode.
 *
 * Worded to avoid referencing a global policy block (which no longer exists),
 * so the reminder stands on its own when injected into the discuss prompt.
 */
export function buildAnswerQualityReminder(): string {
  return "Be direct, avoid flattery/reflexive agreement, check uncertain assumptions against available evidence, and ask concise questions only when key information is missing, ambiguous, or high-risk.";
}
