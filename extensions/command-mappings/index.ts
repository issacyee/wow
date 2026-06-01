/**
 * Command Mappings — Generic command alias/extension registry
 *
 * Declaratively define multiple command aliases in one place, instead of
 * creating one extension file per alias. Add new mappings by appending
 * entries to the COMMAND_MAPPINGS array.
 *
 * Example mappings:
 *   /exit → ctx.shutdown()  (alias of built-in /quit)
 *   /e    → ctx.shutdown()  (short alias)
 *   /q    → ctx.shutdown()  (another common quit alias)
 */

import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Types ──

interface CommandMapping {
  /** Command name (what user types after /) */
  name: string;
  /** Human-readable description shown in help */
  description: string;
  /** Handler function invoked when the command is executed */
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

// ── Mappings ──
// Add new command aliases here. Each entry registers a /<name> command.

const COMMAND_MAPPINGS: CommandMapping[] = [
  {
    name: "exit",
    description: "Exit pi (alias of /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  },
];

// ── Extension entry ──

export default function (pi: ExtensionAPI) {
  for (const mapping of COMMAND_MAPPINGS) {
    pi.registerCommand(mapping.name, {
      description: mapping.description,
      handler: mapping.handler,
    });
  }
}
