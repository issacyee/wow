/**
 * Bash command safety check
 * In planning mode, only allow read-only commands, block everything else.
 *
 * Uses shell-quote for proper shell parsing (handles quotes, escapes,
 * environment variables correctly — no more regex splitting vulnerable
 * to injected shell operators in quoted strings).
 */

import { parse } from "shell-quote";

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

// ── Token-based safety check (shell-quote powered) ──

/**
 * Check whether a token-based command segment is safe.
 * Tokens are already parsed by shell-quote, so no string parsing needed.
 */
function isSegmentSafeFromTokens(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  // Skip leading environment variable assignments: VAR=val
  let cmdIdx = 0;
  while (cmdIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmdIdx])) {
    cmdIdx++;
  }
  if (cmdIdx >= tokens.length) return false;

  const cmd = tokens[cmdIdx];
  const args = tokens.slice(cmdIdx + 1);

  // ── git special handling ──
  if (cmd === "git") {
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
 * Uses shell-quote to properly parse shell syntax. Quoted strings are
 * preserved as single tokens, preventing attackers from injecting
 * operators inside quotes to bypass the allowlist.
 *
 * Strategy: parse the command, split on shell operators (; | || &&),
 * reject redirections (> >> < <<), and check each segment independently.
 */
export function isSafeCommand(command: string): boolean {
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    // If shell-quote can't parse it, don't allow it
    return false;
  }

  // Reject redirections and here-strings
  for (const token of tokens) {
    if (typeof token === "object" && "op" in token) {
      if (token.op === ">" || token.op === ">>" || token.op === "<" || token.op === "<<") {
        return false;
      }
    }
  }

  // Group tokens into segments separated by shell operators (; | || &&)
  let currentSegmentTokens: string[] = [];

  for (const token of tokens) {
    if (typeof token === "object" && "op" in token) {
      // Shell operator — check the accumulated segment
      if (currentSegmentTokens.length > 0) {
        if (!isSegmentSafeFromTokens(currentSegmentTokens)) return false;
        currentSegmentTokens = [];
      }
      continue;
    }

    if (typeof token === "string") {
      currentSegmentTokens.push(token);
    }
    // Pattern tokens (globs like *.ts), comment tokens, and other
    // non-string tokens are arguments — skip them silently
  }

  // Check the last segment
  if (currentSegmentTokens.length > 0) {
    if (!isSegmentSafeFromTokens(currentSegmentTokens)) return false;
  }

  return true;
}
