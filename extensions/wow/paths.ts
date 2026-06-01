/**
 * Path and command display utilities
 *
 * Shorten paths for TUI display and create clickable OSC 8 file:// hyperlinks.
 */

import { hyperlink } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Shorten home directory paths to ~/... and truncate very long paths */
export function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  if (path.length > 55) {
    return path.slice(0, 24) + "..." + path.slice(-28);
  }
  return path;
}

/**
 * Resolve a path relative to cwd and wrap it in an OSC 8 file:// hyperlink.
 * Falls back to plain text if the path cannot be resolved.
 */
export function linkPath(path: string, cwd: string): string {
  try {
    const abs = resolve(cwd, path);
    return hyperlink(shortenPath(path), `file://${abs}`);
  } catch {
    return shortenPath(path);
  }
}

/** Truncate a command string to a reasonable display length */
export function shortenCommand(cmd: string): string {
  const collapsed = cmd.replace(/\s+/g, " ").trim();
  if (collapsed.length > 60) {
    return collapsed.slice(0, 57) + "...";
  }
  return collapsed;
}
