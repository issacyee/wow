/**
 * Bash command safety check.
 * Used by read-only workflow modes to allow inspection commands only.
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
  "sort", "uniq", "comm", "diff", "cmp", "tr",

  // System info
  "pwd", "whoami", "id", "uname", "hostname", "date", "uptime",
  "env", "printenv", "echo", "printf", "type",
  "arch", "nproc", "lscpu", "free",

  // Code counting / analysis
  "cloc", "scc", "tokei",

  // Network inspection
  "ping", "traceroute", "nslookup", "dig", "host", "whois", "curl",

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
  codegraph: new Set(["status", "query", "explore", "node", "callers", "callees", "impact", "files", "context", "affected"]),
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

/** git branch is only safe for listing/showing branch information */
function isSafeGitBranch(args: string[]): boolean {
  if (args.length === 0) return true;

  const allowed = new Set([
    "-a", "--all",
    "-r", "--remotes",
    "-v", "-vv", "--verbose",
    "--list",
    "--show-current",
    "--contains",
    "--merged",
    "--no-merged",
    "--color", "--no-color",
  ]);

  return args.every((arg) => allowed.has(arg) || /^--color=/.test(arg));
}

/** git remote is only safe for listing/showing remote information */
function isSafeGitRemote(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.length === 1 && args[0] === "-v") return true;
  if (args[0] === "show") return true;
  if (args[0] === "get-url") return true;
  return false;
}

/** git tag is only safe for listing tags */
function isSafeGitTag(args: string[]): boolean {
  if (args.length === 0) return true;
  const allowed = new Set(["-l", "--list", "-n"]);
  return args.every((arg) => allowed.has(arg) || arg.startsWith("-n"));
}

/** git config is only safe for --get and --list */
function isSafeGitConfig(args: string[]): boolean {
  return args.length > 0 && (args[0] === "--get" || args[0] === "--list");
}

/** git read commands must not use output-to-file options */
function isSafeGitReadArgs(args: string[]): boolean {
  return !args.some((arg) => arg === "--output" || arg.startsWith("--output="));
}

/** find can delete or execute arbitrary commands; allow listing predicates only */
function isSafeFindArgs(args: string[]): boolean {
  const blocked = new Set([
    "-delete",
    "-exec", "-execdir",
    "-ok", "-okdir",
    "-fprint", "-fprint0", "-fprintf",
    "-fls",
  ]);
  return !args.some((arg) => blocked.has(arg));
}

/** curl is safe only as a read-only fetch without local writes/uploads/mutating methods */
function isSafeCurlArgs(args: string[]): boolean {
  const blockedExact = new Set([
    "-o", "-O", "--output", "--remote-name", "--remote-header-name",
    "--output-dir", "--create-dirs",
    "-D", "--dump-header",
    "-c", "--cookie-jar",
    "-T", "--upload-file",
    "-K", "--config",
    "--trace", "--trace-ascii", "--trace-time",
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "-F", "--form",
    "-X", "--request",
  ]);

  return !args.some((arg) =>
    blockedExact.has(arg) ||
    /^-[oODcTKdFX].+/.test(arg) ||
    arg.startsWith("--output=") ||
    arg.startsWith("--output-dir=") ||
    arg.startsWith("--dump-header=") ||
    arg.startsWith("--cookie-jar=") ||
    arg.startsWith("--upload-file=") ||
    arg.startsWith("--config=") ||
    arg.startsWith("--trace=") ||
    arg.startsWith("--trace-ascii=") ||
    arg.startsWith("--data=") ||
    arg.startsWith("--data-raw=") ||
    arg.startsWith("--data-binary=") ||
    arg.startsWith("--data-urlencode=") ||
    arg.startsWith("--form=") ||
    arg.startsWith("--request=")
  );
}

function isSafeNpmAuditArgs(args: string[]): boolean {
  return !args.includes("fix");
}

function isSafeEnvArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (["-0", "--null", "-i", "--ignore-environment"].includes(arg)) continue;
    if (arg === "-u" || arg === "--unset") {
      i++; // variable name argument
      continue;
    }
    if (arg.startsWith("--unset=")) continue;

    // Any other non-assignment token would be executed as a command by env.
    return false;
  }

  return true;
}

function isSafeSortArgs(args: string[]): boolean {
  return !args.some((arg) => arg === "-o" || /^-o.+/.test(arg) || arg === "--output" || arg.startsWith("--output="));
}

function isSafeDateArgs(args: string[]): boolean {
  return !args.some((arg) => arg === "-s" || /^-s.+/.test(arg) || arg === "--set" || arg.startsWith("--set="));
}

function isSafeHostnameArgs(args: string[]): boolean {
  // `hostname new-name` mutates the system hostname on platforms where allowed.
  return args.every((arg) => arg.startsWith("-"));
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
    if (subcmd === "branch") return isSafeGitBranch(args.slice(1));
    if (subcmd === "remote") return isSafeGitRemote(args.slice(1));
    if (subcmd === "tag") return isSafeGitTag(args.slice(1));
    if (subcmd === "config") return isSafeGitConfig(args.slice(1));

    return isSafeGitReadArgs(args.slice(1));
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

    if (cmd === "npm" && subcmd === "audit") {
      return isSafeNpmAuditArgs(args.slice(1));
    }

    return multipart.has(subcmd);
  }

  // ── Simple commands ──
  if (!SAFE_SIMPLE_COMMANDS.has(cmd)) return false;
  if (cmd === "find") return isSafeFindArgs(args);
  if (cmd === "curl") return isSafeCurlArgs(args);
  if (cmd === "env") return isSafeEnvArgs(args);
  if (cmd === "sort") return isSafeSortArgs(args);
  if (cmd === "date") return isSafeDateArgs(args);
  if (cmd === "hostname") return isSafeHostnameArgs(args);
  return true;
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
