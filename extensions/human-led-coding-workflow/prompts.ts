/**
 * Prompt builders for Human-Led Coding Workflow.
 *
 * Prefix-cache rule: keep these instructions byte-stable. Do not add OS locale,
 * timestamps, random IDs, git status, counters, or other transient data here.
 */

import { EXECUTE_MARKER, type TodoItem } from "./plan.ts";

export type WorkflowMode = "discuss" | "plan" | "revise" | "execute";

export const WORKFLOW_CONTEXT_TYPE = "human-led-coding-workflow-context";

const READ_ONLY_TOOLS = "read, grep, find, ls, bash(read-only allowlist), webfetch";

export function buildDiscussPrompt(): string {
  return `[HUMAN-LED CODING WORKFLOW: DISCUSS]

Role: discuss and analyze with the human as the decision maker.

Rules:
- Treat the user's current message as the active discussion focus.
- Use prior conversation as background only; do not assume the previous topic remains the focus.
- Continue a previous topic only when the user explicitly refers to it. If the user introduces a new topic, switch focus to the new topic.
- Explore the codebase when useful with: ${READ_ONLY_TOOLS}.
- Do not edit files or write new files.
- Do not produce an implementation plan unless the user explicitly asks for one with ?? .
- If the issue is ambiguous, ask concise clarifying questions.
- If implementation seems appropriate, explain the findings and invite the user to request a plan with ?? .`;
}

interface PlanPromptOptions {
  fromPreviousDiscussion?: boolean;
}

export function buildPlanPrompt(options: PlanPromptOptions = {}): string {
  const sourceInstruction = options.fromPreviousDiscussion
    ? "\n- The user sent ?? without extra text. Treat this as full approval of the most recent discussion result and write the plan from that discussion."
    : "";

  return `[HUMAN-LED CODING WORKFLOW: WRITE NEW PLAN]

Role: create a new reviewable plan for the human. This replaces any previous active plan.

Rules:${sourceInstruction}
- Explore the codebase first when needed with: ${READ_ONLY_TOOLS}.
- If critical information is missing, ask concise questions and do not output a plan yet.
- Do not edit files or write new files.
- Converge on one recommended approach; do not list alternatives unless a decision truly needs human input.
- The plan is for human review. Do not start implementation.

Required output when ready:

## Plan: {short title}

### Goals
{what success means}

### Background
{why the change is needed and relevant findings}

### Key Decisions
{important implementation decisions and rationale}

### Non-goals
{what is intentionally out of scope}

### Implementation Steps
1. **Action** — concrete, directly executable step.
2. **Action** — concrete, directly executable step.
3. ...

### Acceptance Criteria
{observable criteria the human can use to approve the result}

### Verification
{how to verify the result}

### Risks
{main risks, edge cases, or tradeoffs}

End the plan with this exact single line:
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
- After completing an implementation step, include [DONE:n] where n is the step number.
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
