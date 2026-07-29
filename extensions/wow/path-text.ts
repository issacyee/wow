/** UI-independent path labels for logs, notifications, and other text channels. */

import { homedir } from "node:os";

function homeLabel(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Shorten a plain-text path while preserving both its root and trailing segment. */
export function shortenPlainPath(path: string, maxLength = 55): string {
  const label = homeLabel(path);
  if (maxLength <= 0) return "";
  if (label.length <= maxLength) return label;
  if (maxLength <= 3) return ".".repeat(maxLength);

  const available = maxLength - 3;
  const headLength = Math.max(1, Math.floor(available * 0.35));
  const tailLength = Math.max(1, available - headLength);
  return `${label.slice(0, headLength)}...${label.slice(-tailLength)}`;
}
