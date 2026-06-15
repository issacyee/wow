/**
 * Wow TUI — global visual shell for the wow package.
 *
 * This is the package's single owner for singleton TUI resources such as the
 * footer and editor component. Logic extensions expose state; wow-tui composes
 * and presents that state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subscribeWorkflowState, WORKFLOW_STATE_TYPE } from "../human-led-coding-workflow/state.ts";
import { installBtwAskTimer, registerBtwRendering } from "./btw.ts";
import { WOW_TUI_CONFIG } from "./config.ts";
import { registerConfigUI } from "./config-ui.ts";
import { createEditorComponent } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { registerFocusToolRendering } from "./tools.ts";
import { registerWowTuiTips } from "./tips.ts";
import { updateWorkflowWidgets } from "./widgets.ts";
import { createWorkingTimerController } from "./working.ts";

const VIEGO_THEME_NAME = "Viego";

function applyWowDefaultTheme(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const currentThemeName = ctx.ui.theme.name;
  if (currentThemeName !== "dark" && currentThemeName !== "light") return;

  const viego = ctx.ui.getTheme(VIEGO_THEME_NAME);
  if (!viego) return;

  ctx.ui.setTheme(viego);
}

export default function wowTuiExtension(pi: ExtensionAPI): void {
  const unregisterTips = registerWowTuiTips();
  registerConfigUI(pi);

  if (WOW_TUI_CONFIG.focusToolRendering) {
    registerFocusToolRendering(pi);
  }

  if (WOW_TUI_CONFIG.btwRendering) {
    registerBtwRendering(pi);
  }

  const workingTimerController = WOW_TUI_CONFIG.workingTimers
    ? createWorkingTimerController(pi)
    : undefined;

  let unsubscribeWorkflow: (() => void) | undefined;
  let cleanupBtwAskTimer: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    unsubscribeWorkflow?.();
    unsubscribeWorkflow = undefined;
    cleanupBtwAskTimer?.();
    cleanupBtwAskTimer = undefined;

    if (!ctx.hasUI) return;

    applyWowDefaultTheme(ctx);

    if (WOW_TUI_CONFIG.workingTimers) {
      workingTimerController?.startSession(ctx);
    }

    if (WOW_TUI_CONFIG.btwRendering) {
      cleanupBtwAskTimer = installBtwAskTimer(ctx);
    }

    if (WOW_TUI_CONFIG.footer) {
      installFooter(pi, ctx);
    }

    if (WOW_TUI_CONFIG.editor) {
      ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) =>
        createEditorComponent(tui, theme, keybindings, ctx.ui.theme)
      );
    }

    if (WOW_TUI_CONFIG.workflowWidgets) {
      const refreshWorkflowWidgets = () => updateWorkflowWidgets(ctx);
      unsubscribeWorkflow = subscribeWorkflowState(refreshWorkflowWidgets);
      refreshWorkflowWidgets();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribeWorkflow?.();
    unsubscribeWorkflow = undefined;
    cleanupBtwAskTimer?.();
    cleanupBtwAskTimer = undefined;
    unregisterTips();

    if (!ctx.hasUI) return;

    if (WOW_TUI_CONFIG.footer) {
      ctx.ui.setFooter(undefined);
    }
    if (WOW_TUI_CONFIG.editor) {
      ctx.ui.setEditorComponent(undefined);
    }
    if (WOW_TUI_CONFIG.workflowWidgets) {
      ctx.ui.setStatus(WORKFLOW_STATE_TYPE, undefined);
      ctx.ui.setWidget(`${WORKFLOW_STATE_TYPE}-todos`, undefined);
    }
    if (WOW_TUI_CONFIG.workingTimers) {
      workingTimerController?.shutdownSession();
    }
  });
}
