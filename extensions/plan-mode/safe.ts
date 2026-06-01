/**
 * Bash command safety check
 * In planning mode, only allow read-only commands, block everything else.
 *
 * Logic: extract the command name (first word) from each segment and check
 * it against a known-safe set. This avoids false positives from argument
 * names that happen to match safe commands (e.g. "touch file.txt" matching /\bfile\b/).
 */

// ── Safe command definitions ──

/**
 * Simple command names — the first word of the segment must match exactly.
 * Flags and arguments are irrelevant as long as the command itself is read-only.
 */
const SAFE_SIMPLE_COMMANDS = new Set([
  // File viewing
  "cat", "head", "tail", "less", "more", "wc",
  "file", "stat", "md5sum", "sha256sum", "cksum",
  "cut", "paste", "column",

  // Directory listing
  "ls", "find", "tree", "du", "df",
  "realpath", "which", "whereis", "readlink", "basename", "dirname",

  // Search / filter
  "grep", "egrep", "fgrep", "rg", "ag",
  "awk", "sort", "uniq", "comm", "diff", "cmp", "tr", "xargs",

  // System info
  "pwd", "whoami", "id", "uname", "hostname", "date", "uptime",
  "env", "printenv", "echo", "printf", "type",
  "arch", "nproc", "lscpu", "free",

  // Code counting / analysis
  "cloc", "scc", "tokei",

  // Network inspection
  "ping", "traceroute", "nslookup", "dig", "host", "whois", "curl", "wget",

  // Process viewing
  "ps", "top", "htop", "lsof", "ss", "netstat",

  // Misc safe
  "test", "true", "false", "expr", "bc", "seq", "sleep", "man",
]);

/**
 * Multi-word command patterns — [command, subcommand] pairs.
 * Checked when the first word is one of these commands.
 */
const SAFE_MULTIPART: Record<string, Set<string>> = {
  npm: new Set(["list", "ls", "view", "info", "outdated", "audit", "explain", "repo", "docs", "root", "prefix"]),
  yarn: new Set(["list", "info", "why", "outdated", "config"]),
  pnpm: new Set(["list", "ls", "info", "why", "outdated"]),
  pip: new Set(["list", "show", "check"]),
  apt: new Set(["list", "show", "search", "policy", "cache"]),
  "apt-get": new Set(["list", "show", "search", "policy", "cache"]),
  brew: new Set(["list", "info", "search", "outdated", "config", "doctor"]),
  docker: new Set(["ps", "images", "inspect", "logs", "stats", "version", "info", "search", "history", "port", "top", "diff"]),
};

/** npm config is special: "npm config get" and "npm config list" are safe */
const SAFE_NPM_CONFIG = new Set(["get", "list"]);

/** Read-only git subcommands */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "branch", "show",
  "stash", "tag", "remote", "rev-parse",
  "ls-files", "ls-tree", "blame", "shortlog",
  "describe", "reflog", "count-objects", "config",
]);

/** git stash is only safe for "git stash list" */
const SAFE_GIT_STASH_SUB = new Set(["list"]);

/** git tag is only safe for "git tag -l" (list) */
function isSafeGitTag(args: string[]): boolean {
  return args.length === 0 || args[0] === "-l";
}

/** git config is only safe for --get and --list */
function isSafeGitConfig(args: string[]): boolean {
  return args.length > 0 && (args[0] === "--get" || args[0] === "--list");
}

/**
 * Extract the command name (first word) from a shell segment.
 * Handles leading environment variable assignments (e.g. "VAR=val command args").
 */
function extractCommandName(segment: string): string {
  // Strip leading env assignments: "VAR=val " or "VAR=value "
  const stripped = segment.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
  // First word is the command
  const match = stripped.match(/^(\S+)/);
  return match ? match[1] : "";
}

/**
 * Extract all words after the command name for subcommand checking.
 */
function extractArgs(segment: string): string[] {
  const stripped = segment.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
  const parts = stripped.split(/\s+/);
  // parts[0] is the command, parts[1..] are args
  return parts.slice(1).filter((p) => p.length > 0);
}

/**
 * Check whether a single command segment is safe.
 */
function isSegmentSafe(segment: string): boolean {
  const cmd = extractCommandName(segment);
  if (!cmd) return false;

  // ── git special handling ──
  if (cmd === "git") {
    const args = extractArgs(segment);
    if (args.length === 0) return false;
    const subcmd = args[0];

    if (!SAFE_GIT_SUBCOMMANDS.has(subcmd)) return false;

    // Extra restrictions for specific subcommands
    if (subcmd === "stash") return args.length > 1 && SAFE_GIT_STASH_SUB.has(args[1]);
    if (subcmd === "tag") return isSafeGitTag(args.slice(1));
    if (subcmd === "config") return isSafeGitConfig(args.slice(1));
    if (subcmd === "branch") return true; // "git branch" lists branches; -d/-D requires write intent but is not destructive enough to block in planning mode

    return true;
  }

  // ── Multi-word commands (npm, yarn, etc.) ──
  const multipart = SAFE_MULTIPART[cmd];
  if (multipart) {
    const args = extractArgs(segment);
    if (args.length === 0) return false;
    const subcmd = args[0];

    // npm config get / npm config list
    if (cmd === "npm" && subcmd === "config" && args.length > 1) {
      return SAFE_NPM_CONFIG.has(args[1]);
    }

    return multipart.has(subcmd);
  }

  // ── Simple commands ──
  return SAFE_SIMPLE_COMMANDS.has(cmd);
}

/**
 * Check whether a command is safe (matches a known read-only pattern).
 *
 * Strategy: split compound commands on `&&`, `||`, `;`, `|` and check each
 * segment independently. The overall command is safe only if every segment
 * is safe.
 */
export function isSafeCommand(command: string): boolean {
  // Reject redirections
  if (/>>/.test(command)) return false;
  if (/(^|[^>])>(?!>)/.test(command)) return false;

  // Split compound commands into individual segments
  const segments = command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) return false;

  return segments.every(isSegmentSafe);
}
