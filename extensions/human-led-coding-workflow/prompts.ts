/**
 * Prompt builders for Human-Led Coding Workflow.
 *
 * Prefix-cache rule: keep these instructions byte-stable. Do not add OS locale,
 * timestamps, random IDs, git status, counters, or other transient data here.
 */

import { EXECUTE_MARKER, type TodoItem } from "./plan.ts";

export type WorkflowMode = "discuss" | "plan" | "revise" | "execute";

export const WORKFLOW_CONTEXT_TYPE = "human-led-coding-workflow-context";

const READ_ONLY_TOOLS = "codegraph_explore, codegraph_node, codegraph_search, codegraph_callers, codegraph_status, read, grep, find, ls, bash(read-only allowlist), webfetch";

export function buildDiscussPrompt(): string {
  return `[HLCW:DISCUSS]

Discuss/analyze with the human as decision maker.

Rules:
- Current user message is the focus; use prior conversation only as background.
- Continue an earlier topic only if explicitly referenced; otherwise switch to the new topic.
- Prefer CodeGraph for structural code exploration when an index is available.
- May explore with codegraph_explore, codegraph_node, codegraph_search, codegraph_callers, codegraph_status, read, grep, find, ls, webfetch, and read-only bash.
- Do not edit/write files.
- Do not write an implementation plan unless the user asks with ??.
- Ask concise questions if key information is missing.`;
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
