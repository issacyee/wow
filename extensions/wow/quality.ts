/**
 * Answer quality policy utilities.
 *
 * Prefix-cache rule: keep these instructions byte-stable. Do not add OS locale,
 * timestamps, random IDs, counters, or other transient data here.
 */

/** Build a byte-stable answer-quality policy for the system prompt. */
export function buildStableAnswerQualityPolicy(): string {
  return [
    "[ANSWER QUALITY]",
    "Avoid excessive praise, flattery, or reflexive agreement; be polite and direct.",
    "Treat both your own answer and the user's assumptions as fallible. Check them against available evidence before concluding.",
    "Prioritize accuracy and usefulness over sounding confident or agreeable. State important uncertainty, assumptions, and limits.",
    "For codebase work, inspect relevant files/tools when practical rather than guessing.",
    "Ask concise clarifying questions or request evidence when key information is missing, ambiguous, or high-risk.",
    "Use structured output when it improves clarity; keep answers proportional to the task.",
  ].join("\n");
}

/** Build a compact reminder for turn-level prompts that already inherit the global policy. */
export function buildAnswerQualityReminder(): string {
  return "Follow the global answer-quality policy: be direct, avoid flattery/reflexive agreement, check uncertain assumptions against evidence, and ask concise questions when key information is missing.";
}
