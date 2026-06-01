/**
 * Test suite for safe.ts — whitelist-based command safety check
 * Run: npx tsx extensions/plan-mode/__tests__/safe.ts
 */

import assert from "node:assert/strict";
import { isSafeCommand } from "../safe.ts";

let passed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// ── Safe commands — should be allowed ──

test("git status is safe", () => assert.ok(isSafeCommand("git status")));
test("git log is safe", () => assert.ok(isSafeCommand("git log --oneline -10")));
test("git diff is safe", () => assert.ok(isSafeCommand("git diff HEAD")));
test("git branch is safe", () => assert.ok(isSafeCommand("git branch")));
test("git show is safe", () => assert.ok(isSafeCommand("git show HEAD")));
test("git blame is safe", () => assert.ok(isSafeCommand("git blame file.ts")));
test("git rev-parse is safe", () => assert.ok(isSafeCommand("git rev-parse --abbrev-ref HEAD")));
test("git ls-files is safe", () => assert.ok(isSafeCommand("git ls-files")));
test("git stash list is safe", () => assert.ok(isSafeCommand("git stash list")));
test("git tag -l is safe", () => assert.ok(isSafeCommand("git tag -l")));
test("git remote -v is safe", () => assert.ok(isSafeCommand("git remote -v")));
test("git config --get is safe", () => assert.ok(isSafeCommand("git config --get user.name")));
test("git config --list is safe", () => assert.ok(isSafeCommand("git config --list")));

test("ls is safe", () => assert.ok(isSafeCommand("ls -la")));
test("cat is safe", () => assert.ok(isSafeCommand("cat file.txt")));
test("grep is safe", () => assert.ok(isSafeCommand("grep -r pattern src/")));
test("find is safe", () => assert.ok(isSafeCommand("find . -name '*.ts'")));
test("head is safe", () => assert.ok(isSafeCommand("head -20 file.txt")));
test("tail is safe", () => assert.ok(isSafeCommand("tail -20 file.txt")));
test("wc is safe", () => assert.ok(isSafeCommand("wc -l file.txt")));
test("echo is safe", () => assert.ok(isSafeCommand("echo hello")));
test("pwd is safe", () => assert.ok(isSafeCommand("pwd")));
test("whoami is safe", () => assert.ok(isSafeCommand("whoami")));
test("env is safe", () => assert.ok(isSafeCommand("env")));
test("uname is safe", () => assert.ok(isSafeCommand("uname -a")));
test("date is safe", () => assert.ok(isSafeCommand("date")));
test("df is safe", () => assert.ok(isSafeCommand("df -h")));
test("du is safe", () => assert.ok(isSafeCommand("du -sh .")));
test("tree is safe", () => assert.ok(isSafeCommand("tree -L 2")));
test("which is safe", () => assert.ok(isSafeCommand("which node")));
test("diff is safe", () => assert.ok(isSafeCommand("diff a.txt b.txt")));
test("awk is safe", () => assert.ok(isSafeCommand("awk '{print $1}' file.txt")));
test("sort is safe", () => assert.ok(isSafeCommand("sort file.txt")));
test("uniq is safe", () => assert.ok(isSafeCommand("uniq file.txt")));
test("cloc is safe", () => assert.ok(isSafeCommand("cloc .")));
test("ps is safe", () => assert.ok(isSafeCommand("ps aux")));
test("ping is safe", () => assert.ok(isSafeCommand("ping google.com")));
test("dig is safe", () => assert.ok(isSafeCommand("dig example.com")));
test("curl is safe", () => assert.ok(isSafeCommand("curl https://example.com")));
test("file is safe", () => assert.ok(isSafeCommand("file image.png")));
test("stat is safe", () => assert.ok(isSafeCommand("stat file.txt")));

test("npm list is safe", () => assert.ok(isSafeCommand("npm list")));
test("npm view is safe", () => assert.ok(isSafeCommand("npm view express")));
test("npm outdated is safe", () => assert.ok(isSafeCommand("npm outdated")));
test("npm config get is safe", () => assert.ok(isSafeCommand("npm config get prefix")));
test("npm config list is safe", () => assert.ok(isSafeCommand("npm config list")));

test("docker ps is safe", () => assert.ok(isSafeCommand("docker ps")));
test("docker images is safe", () => assert.ok(isSafeCommand("docker images")));
test("docker logs is safe", () => assert.ok(isSafeCommand("docker logs container")));

// ── Dangerous commands — should be blocked ──

test("rm is blocked", () => assert.ok(!isSafeCommand("rm -rf /")));
test("rmdir is blocked", () => assert.ok(!isSafeCommand("rmdir dir")));
test("mv is blocked", () => assert.ok(!isSafeCommand("mv a.txt b.txt")));
test("cp is blocked", () => assert.ok(!isSafeCommand("cp a.txt b.txt")));
test("mkdir is blocked", () => assert.ok(!isSafeCommand("mkdir newdir")));
test("touch is blocked", () => assert.ok(!isSafeCommand("touch file.txt")));
test("chmod is blocked", () => assert.ok(!isSafeCommand("chmod 755 file.sh")));

test("node is blocked", () => assert.ok(!isSafeCommand("node -e \"console.log('hack')\"")));
test("python is blocked", () => assert.ok(!isSafeCommand("python -c \"print('hack')\"")));
test("perl is blocked", () => assert.ok(!isSafeCommand("perl -e \"print 'hack'\"")));
test("ruby is blocked", () => assert.ok(!isSafeCommand("ruby -e \"puts 'hack'\"")));

test("npm install is blocked", () => assert.ok(!isSafeCommand("npm install express")));
test("npm uninstall is blocked", () => assert.ok(!isSafeCommand("npm uninstall express")));
test("npm ci is blocked", () => assert.ok(!isSafeCommand("npm ci")));
test("yarn add is blocked", () => assert.ok(!isSafeCommand("yarn add express")));
test("pnpm add is blocked", () => assert.ok(!isSafeCommand("pnpm add express")));
test("pip install is blocked", () => assert.ok(!isSafeCommand("pip install flask")));

test("git add is blocked", () => assert.ok(!isSafeCommand("git add .")));
test("git commit is blocked", () => assert.ok(!isSafeCommand("git commit -m 'msg'")));
test("git push is blocked", () => assert.ok(!isSafeCommand("git push")));
test("git pull is blocked", () => assert.ok(!isSafeCommand("git pull")));
test("git merge is blocked", () => assert.ok(!isSafeCommand("git merge main")));
test("git checkout is blocked", () => assert.ok(!isSafeCommand("git checkout main")));
test("git stash (without list) is blocked", () => assert.ok(!isSafeCommand("git stash")));
test("git stash push is blocked", () => assert.ok(!isSafeCommand("git stash push")));
test("git init is blocked", () => assert.ok(!isSafeCommand("git init")));

test("sudo is blocked", () => assert.ok(!isSafeCommand("sudo rm -rf /")));
test("vim is blocked", () => assert.ok(!isSafeCommand("vim file.txt")));
test("nano is blocked", () => assert.ok(!isSafeCommand("nano file.txt")));

test("tee is blocked", () => assert.ok(!isSafeCommand("echo hello | tee file.txt")));

test("docker run is blocked", () => assert.ok(!isSafeCommand("docker run ubuntu")));
test("docker build is blocked", () => assert.ok(!isSafeCommand("docker build .")));

test("brew install is blocked", () => assert.ok(!isSafeCommand("brew install node")));

// ── Compound commands ──

test("ls && git status is safe (both safe)", () => assert.ok(isSafeCommand("ls && git status")));
test("ls && rm is blocked (one unsafe)", () => assert.ok(!isSafeCommand("ls && rm file.txt")));
test("git status || pwd is safe (both safe)", () => assert.ok(isSafeCommand("git status || pwd")));
test("git log; npm install is blocked (one unsafe)", () => assert.ok(!isSafeCommand("git log; npm install")));

test("piped safe commands: ls | grep foo", () => assert.ok(isSafeCommand("ls | grep foo")));
test("piped unsafe: ls | node", () => assert.ok(!isSafeCommand("ls | node")));

// ── Redirections ──

test("> redirect is blocked", () => assert.ok(!isSafeCommand("echo hello > file.txt")));
test(">> append is blocked", () => assert.ok(!isSafeCommand("echo hello >> file.txt")));

// ── Edge cases — false positive prevention ──

test("touch file.txt is blocked (file is an arg, not a command)", () => assert.ok(!isSafeCommand("touch file.txt")));
test("stat file.txt is safe (stat IS the command)", () => assert.ok(isSafeCommand("stat file.txt")));
test("file image.png is safe (file IS the command)", () => assert.ok(isSafeCommand("file image.png")));
test("echo stat is safe (echo is the command, stat is an arg)", () => assert.ok(isSafeCommand("echo stat")));

test("empty string is blocked", () => assert.ok(!isSafeCommand("")));
test("whitespace is blocked", () => assert.ok(!isSafeCommand("   ")));

console.log(`\n✓ All ${passed} tests passed`);
