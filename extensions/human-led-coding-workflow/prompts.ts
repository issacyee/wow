/**
 * Prompt builders for Human-Led Coding Workflow.
 *
 * Prefix-cache rule: keep these instructions byte-stable. Do not add OS locale,
 * timestamps, random IDs, git status, counters, or other transient data here.
 */

import { buildAnswerQualityReminder } from "../wow/quality.ts";
import type { DiscussLevel } from "../wow/settings.ts";
import { EXECUTE_MARKER, type TodoItem } from "./plan.ts";

export type WorkflowMode = "discuss" | "plan" | "revise" | "execute";

export const WORKFLOW_CONTEXT_TYPE = "human-led-coding-workflow-context";

const READ_ONLY_TOOLS = "codegraph_explore, codegraph_node, codegraph_search, codegraph_callers, codegraph_status, read, grep, find, ls, bash(read-only allowlist), webfetch";

const ASK_FORMAT_SECTION = `

Structured questions:
- When you must ask the human to decide between options, emit a \`:::ask\` fenced block instead of a free-form question. Only ask when a real decision is needed; prefer fewer questions.
- Format:
  \`\`\`
  :::ask id=<stable-id> multiple=<true|false> allowCustom=<true|false>
  question: <the question>
  hint: <optional guidance>
  - [x] <recommended option (your preferred answer)>
  - [ ] <another option>
  \`\`\`
- \`id\` is required and must be stable within this reply. \`multiple\` defaults to false (single choice). \`allowCustom\` defaults to true.
- Mark exactly one option \`[x]\` for single-choice (your recommendation), or several for multiple-choice.
- Options should be mutually exclusive and self-explanatory; \`hint\` carries trade-off context.
- If a question needs no discrete options (open-ended), still emit the block with the options omitted and \`allowCustom=true\`; the user will type a custom answer.
- The user's reply will arrive as a \`[Discuss answers]\` message mapping each id to the chosen option(s), a custom value, or \`(skipped — 你自行判断决定)\`. When an id is skipped, decide yourself and continue; do not ask again.
- Output rules (strict — the parser is line-based):
  • Do NOT wrap the block in a markdown code fence. Emit the lines verbatim, not inside triple-backticks.
  • End every block with a line containing exactly \`:::\`.
  • Do not indent the lines inside the block (no leading spaces).`;

export function buildDiscussPrompt(level: DiscussLevel): string {
  const reminderLine = level === "strict"
    ? `\n- ${buildAnswerQualityReminder()}`
    : "";

  return `[HLCW:DISCUSS]

Discuss/analyze with the human as decision maker.

Rules:
- Current user message is the focus; use prior conversation only as background.
- Continue an earlier topic only if explicitly referenced; otherwise switch to the new topic.${reminderLine}
- Prefer CodeGraph for structural code exploration when an index is available.
- May explore with codegraph_explore, codegraph_node, codegraph_search, codegraph_callers, codegraph_status, read, grep, find, ls, webfetch, and read-only bash.
- Do not edit/write files.
- Do not write an implementation plan unless the user asks with ??.
- Ask concise questions if key information is missing, using the structured format below when discrete options exist.${ASK_FORMAT_SECTION}`;
}

interface PlanPromptOptions {
  fromPreviousDiscussion?: boolean;
}

export function buildPlanPrompt(options: PlanPromptOptions = {}): string {
  const sourceInstruction = options.fromPreviousDiscussion
    ? "\n- Empty ?? means the user approves the latest discussion; write the plan from it."
    : "";

  return `[HLCW:PLAN]

Write a new reviewable plan. Replace any active plan.

Rules:${sourceInstruction}
- Prefer CodeGraph for structural code exploration when an index is available.
- Explore first when needed: codegraph_explore, codegraph_node, codegraph_search, codegraph_callers, codegraph_status, read, grep, find, ls, webfetch, read-only bash.
- Ask concise questions if critical info is missing; do not output a plan yet.
- Do not edit/write files or start implementation.
- Recommend one approach only unless human input is required.

Output:

## Plan: {short title}

### Goals
...

### Background
...

### Key Decisions
...

### Non-goals
...

### Implementation Steps
1. **Action** — concrete executable step.

### Acceptance Criteria
...

### Verification
...

### Risks
...

End with:
${EXECUTE_MARKER}`;
}

export function buildRevisePrompt(restoredPlan?: string): string {
  const planContext = restoredPlan
    ? `\n\nRestored active plan context (use only if the conversation context does not already contain the plan):\n${restoredPlan}`
    : "";

  return `[HUMAN-LED CODING WORKFLOW: REVISE PLAN]

Role: revise the current active plan based on the human's feedback.

Rules:
- There must already be an active plan in the conversation; use the user's feedback to update it.
- Read relevant code again if needed with: ${READ_ONLY_TOOLS}.
- Do not edit files or write new files.
- Output the full revised plan, not a diff or partial update.
- If critical information is missing, ask concise questions and keep the previous plan active.
- Do not start implementation.

Use the same required plan structure as WRITE NEW PLAN:
Goals, Background, Key Decisions, Non-goals, Implementation Steps, Acceptance Criteria, Verification, Risks.

End a complete revised plan with this exact single line:
${EXECUTE_MARKER}${planContext}`;
}

export function buildExecutePrompt(todoItems: TodoItem[], restoredPlan?: string): string {
  const remaining = todoItems.filter((item) => !item.completed);
  const steps = remaining.length > 0
    ? remaining.map((item) => `${item.step}. ${item.text}`).join("\n")
    : "(No extracted numbered steps. Use the active plan in the conversation.)";

  const planContext = restoredPlan
    ? `\n\nRestored active plan context (use only if the conversation context does not already contain the plan):\n${restoredPlan}`
    : "";

  return `[HUMAN-LED CODING WORKFLOW: EXECUTE PLAN]

Role: execute the human-approved active plan.

Rules:
- Full tool access is allowed in this mode.
- Follow the active plan and incorporate any extra constraints in the user's current message.
- Do not commit changes. The human commits manually.
- After completing an implementation step, immediately output a visible progress line containing [DONE:n] where n is the step number, then continue with later steps.
- Do not wait until the final summary to report completed steps; emit each [DONE:n] as soon as that step is complete.
- When the whole plan is complete, all extracted step numbers must be marked with [DONE:n].
- If the plan is no longer valid, stop and explain instead of improvising a major redesign.

Current remaining steps:
${steps}

Final response format:

## Execution Summary

### Summary
{brief summary of what changed}

### Modified Files
- \`path/to/file\` — {brief change description}

### Follow-up Suggestions
{optional next steps, caveats, or cleanup ideas}${planContext}`;
}
