// Regression test: review-handoff renderer must never emit lines wider than
// the terminal width, including long CJK runs without spaces (the exact
// scenario from pi-crash.log: w=242/290/269 vs terminal width 198).
import { registerWorkflowSummaryRendering } from "../extensions/wow-tui/workflow-summary.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_REVIEW_HANDOFF_TYPE, type WorkflowReviewHandoffDetails } from "../extensions/human-led-coding-workflow/types.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const cjk = "修复提总站（PICKING_SORTING 物理工位切换为人工区理货模式 ROBOT_TO_MANUAL_RELOCATION）理货命中静态来源货架时货架到达偶尔不推送、导致人工区理货任务不显示、业务卡死的问题。目标：任何静态货架都可作为理货来源货架，且货架到达推送稳定、可自动恢复。";

const details: WorkflowReviewHandoffDetails = {
  version: 1,
  todoItems: [
    { step: 1, text: cjk, completed: true },
    { step: 2, text: "short english step", completed: false },
  ],
  content: {
    intent: cjk,
    behavioralChanges: `- **理货静态来源货架的到达推送改为逻辑到达**：${cjk}`,
    executionDelta: `- 新增 RobotToManualStaticShelfPushService（编排：入口分流过滤、货架级分布式锁、游标扫描、重试合并与租户上下文透传、单货架异常隔离）与 RobotToManualStaticShelfDispatchService（REQUIRES_NEW 独立事务：锁内重查任务、目标站校验、逐面通知 Station、成功后推进 PROCESSING）。`,
    existingWorktreeInteractions: "",
    impactSurface: "",
    validationEvidence: "",
    risksAndUnknowns: cjk,
    suggestedReviewPath: cjk,
    modifiedFiles: "",
    followUpSuggestions: "",
  },
  attributionLimitations: "",
  interactingFiles: [cjk, "D:\\workspace\\java\\ms-wms-backend\\modules-ems\\ems-core\\src\\main\\java\\com\\swms\\ems\\core\\application\\static_shelf\\RobotToManualStaticShelfPushService.java"],
};

// Minimal stand-ins for the theme + extension API surfaces used by the renderer.
const theme: any = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
};

let render: ((message: any, options: any, theme: any) => any) | undefined;
const api: any = {
  registerMessageRenderer: (type: string, fn: any) => {
    if (type === WORKFLOW_REVIEW_HANDOFF_TYPE) render = fn;
  },
};

registerWorkflowSummaryRendering(api as ExtensionAPI);
if (!render) throw new Error("renderer not registered");

let failures = 0;
for (const width of [198, 120, 80, 40, 20, 8, 4, 2, 1]) {
  for (const expanded of [false, true]) {
    const node = render({ details }, { expanded }, theme);
    const lines: string[] = node.render(width);
    for (const [i, line] of lines.entries()) {
      const w = visibleWidth(line);
      if (w > width) {
        failures++;
        console.error(`FAIL width=${width} expanded=${expanded} line=${i} visibleWidth=${w}: ${JSON.stringify(line.slice(0, 80))}`);
      }
    }
  }
}
console.log(failures === 0 ? `OK: all lines within width (tested widths incl. 198 with crash-day content)` : `${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
