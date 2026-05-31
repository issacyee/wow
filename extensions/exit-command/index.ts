/**
 * Exit Command — /exit mapped to /quit
 *
 * Registers a /exit command that triggers a graceful shutdown,
 * identical to the built-in /quit command.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Exit pi (alias of /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
