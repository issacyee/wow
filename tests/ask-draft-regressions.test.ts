// Regression tests for discuss ask drafts:
// 1. programmatic editor text changes must schedule a render;
// 2. skipped answers must retain their original question positions.
import { formatAskAnswers, type AskAnswers, type AskQuestion } from "../extensions/human-led-coding-workflow/ask.ts";
import { WowCompositeEditor } from "../extensions/wow-tui/editor.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const questions: AskQuestion[] = [
  {
    id: "first",
    type: "single",
    question: "First question?",
    options: [{ id: "alpha", label: "Alpha" }],
  },
  {
    id: "second",
    type: "single",
    question: "Second question?",
    options: [{ id: "beta", label: "Beta" }],
  },
  {
    id: "third",
    type: "text",
    question: "Third question?",
    options: [],
  },
];

const answers: AskAnswers = {
  first: { kind: "selected", optionIds: ["alpha"] },
  second: { kind: "skipped" },
  third: { kind: "custom", value: "Custom answer" },
};

const answerLines = formatAskAnswers(questions, answers).split("\n").slice(2);
assert(answerLines.length === 3, `expected one draft line per question, got ${answerLines.length}`);
assert(answerLines[0]?.startsWith("1. First question?"), "first answer lost its original position");
assert(answerLines[0]?.includes("Alpha"), "first selected answer is missing");
assert(answerLines[1]?.startsWith("2. Second question?"), "skipped answer moved away from its original position");
assert(
  answerLines[1]?.includes("请你自行判断") || answerLines[1]?.includes("Please decide yourself"),
  "skipped answer is not explicit in its question line",
);
assert(answerLines[2]?.startsWith("3. Third question?"), "third answer was renumbered after a skipped answer");
assert(answerLines[2]?.includes("Custom answer"), "custom answer is missing");

const allSkippedLines = formatAskAnswers(questions, {
  first: { kind: "skipped" },
  second: { kind: "skipped" },
  third: { kind: "skipped" },
}).split("\n").slice(2);
assert(allSkippedLines.length === 3, "all-skipped drafts must still contain one line per question");
assert(
  allSkippedLines.every((line, index) => line.startsWith(`${index + 1}. ${questions[index]!.question}`)),
  "all-skipped drafts lost their original question numbering",
);

let renderRequests = 0;
const tui = {
  requestRender: () => { renderRequests++; },
};
const passthrough = (text: string): string => text;
const theme = {
  borderColor: passthrough,
  selectList: {},
};
const editor = new WowCompositeEditor(tui, theme, {}, { fg: (_name: string, text: string) => text });
editor.setText("? asynchronously filled draft");
assert(editor.getText() === "? asynchronously filled draft", "programmatic draft was not stored in the editor");
assert(renderRequests > 0, "programmatic draft must request a render");

console.log("OK: ask drafts render immediately and preserve skipped-question order");
