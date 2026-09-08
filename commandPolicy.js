/**
 * commandPolicy.js — F2 command security layer for my-agent.
 *
 * DESIGN (stated honestly):
 *  - Commands are tokenized into argv and executed DIRECTLY via
 *    spawn(program, args). No bash/sh/eval is used for ordinary commands.
 *  - Shell syntax (operators, substitution, expansion, globs) is REJECTED
 *    with a clear explanation — never silently executed through a shell.
 *  - A structured risk policy classifies commands:
 *      SAFE_READONLY          known read-only programs
 *      SAFE_PROJECT_COMMAND   common project build/test tools
 *      REQUIRES_CONFIRMATION  anything unrecognized / mutating
 *      RESTRICTED             dangerous-but-sometimes-needed (rm, curl, npx…)
 *                             — always requires confirmation, even in auto
 *      BLOCKED                never runs, in any mode
 *  - Children get a sanitized environment (PATH/HOME/locale only — no API
 *    keys or other parent-env secrets).
 *
 * THIS IS NOT A SANDBOX. Once a program is running it can read absolute
 * paths, use the network, and spawn its own children. Only OS-level
 * isolation (containers, chroot/bubblewrap, MAC policies) provides real
 * containment. Termux execution is ordinary Linux userland — not a sandbox.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CLASSIFICATION = {
  SAFE_READONLY: 'SAFE_READONLY',
  SAFE_PROJECT_COMMAND: 'SAFE_PROJECT_COMMAND',
  REQUIRES_CONFIRMATION: 'REQUIRES_CONFIRMATION',
  RESTRICTED: 'RESTRICTED',
  BLOCKED: 'BLOCKED',
};

// ---------------------------------------------------------------------------
// Hard-refused raw-string patterns (moved here from agentLoop.js in F2;
// applied to the raw command string as defense in depth).
// ---------------------------------------------------------------------------
const BLOCKED_PATTERNS = [
  { re: /\brm\b[^|;&]*\s-{1,2}[a-z]*r/i, why: 'recursive delete (rm -r / rm -rf)' },
  { re: /\bsudo\b/i, why: 'privilege escalation (sudo)' },
  { re: /\bdd\b\s/i, why: 'raw disk write (dd)' },
  { re: /\bmkfs/i, why: 'filesystem format (mkfs)' },
  { re: />\s*\/dev\//, why: 'writing to a device node (> /dev/...)' },
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da|k)?sh\b/i, why: 'piping a download into a shell (curl|sh)' },
  { re: /\bgit\s+push\b[^|;&]*(--force\b|\s-f\b)/i, why: 'forced git push' },
];

/** Returns the human-readable "why" if cmd matches the blocklist, else null. */
export function checkBlocklist(cmd) {
  if (typeof cmd !== 'string') return 'command is not a string';
  for (const { re, why } of BLOCKED_PATTERNS) {
    if (re.test(cmd)) return why;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Program policy tables (matched on the program NAME, not the raw string)
// ---------------------------------------------------------------------------

/** Never executed, regardless of arguments or mode. */
const BLOCKED_PROGRAMS = new Set([
  // shells — spawning a shell would bypass the whole argv policy
  'sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh', 'busybox',
  // privilege escalation / session programs
  'sudo', 'su', 'doas', 'pkexec', 'passwd', 'chsh', 'login',
  // raw disk / filesystem / boot
  'dd', 'fdisk', 'sfdisk', 'parted', 'mount', 'umount', 'shutdown', 'reboot',
  'poweroff', 'halt', 'init', 'telinit',
  // process killers / trampolines that re-inject arbitrary commands
  'kill', 'killall', 'pkill', 'skill', 'snice', 'xargs', 'env', 'nohup',
  'setsid', 'stdbuf', 'timeout', 'watch',
  // isolation escape / injection helpers
  'chroot', 'unshare', 'nsenter', 'setpriv', 'capsh',
]);

/** Executable only with explicit user confirmation — even in auto mode. */
const RESTRICTED_PROGRAMS = new Set([
  'rm', 'chmod', 'chown', 'chgrp', 'ln',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat',
  'npx', 'pip', 'pip3',
  'apt', 'apt-get', 'dpkg', 'rpm', 'yum', 'dnf', 'brew', 'gem',
  'systemctl', 'service', 'crontab', 'at',
  // interpreters with side-effectful builtins (awk system(), sed w-file…)
  'awk', 'gawk', 'sed',
]);

/** Known read-only programs (still subject to arg checks below). */
const READONLY_PROGRAMS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'diff', 'cmp', 'comm', 'cut', 'sort', 'uniq', 'grep', 'rg', 'which',
  'whoami', 'id', 'uname', 'hostname', 'date', 'echo', 'printf', 'realpath',
  'readlink', 'basename', 'dirname', 'md5sum', 'sha1sum', 'sha256sum',
  'cksum', 'nl', 'tac', 'rev', 'tree',
]);

/** Common project tools that build/test (non-readonly but expected). */
const PROJECT_PROGRAMS = new Set([
  'node', 'npm', 'python', 'python3', 'make', 'cmake', 'go', 'cargo', 'mvn',
  'gradle', 'yarn', 'pnpm', 'tsc', 'babel', 'eslint', 'prettier', 'jest',
  'vitest', 'mocha', 'pytest', 'ruff', 'black',
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame',
  'shortlog', 'describe', 'grep',
]);

const NPM_MUTATING_SUBCOMMANDS = new Set([
  'install', 'i', 'ci', 'link', 'unlink', 'publish', 'login', 'adduser',
  'logout', 'init', 'exec', 'pkg', 'cache',
]);

/** find flags that delete/execute — make `find` itself BLOCKED when present. */
const FIND_DANGEROUS_FLAGS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir',
  '-fprint', '-fprint0', '-fprintf', '-fls',
]);

const VERSION_FLAGS = new Set(['-v', '--version', '-h', '--help', '-?', '/?']);

// ---------------------------------------------------------------------------
// Tokenizer: shell-like word splitting WITHOUT any shell interpretation.
// Supported: whitespace splitting, 'single quotes' (fully literal),
// "double quotes" (literal, \\" and \\ escapes), backslash escapes.
// Everything else that a shell would treat specially is REJECTED.
// ---------------------------------------------------------------------------
export function tokenizeCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { error: 'command is empty or not a string' };
  }
  const argv = [];
  let cur = '';
  let hasCur = false;
  const push = () => { if (hasCur) { argv.push(cur); cur = ''; hasCur = false; } };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      hasCur = true;
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return { error: 'unterminated single quote' };
      cur += cmd.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      hasCur = true;
      i++;
      let closed = false;
      for (; i < cmd.length; i++) {
        const d = cmd[i];
        if (d === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) { cur += cmd[i + 1]; i++; continue; }
        if (d === '"') { closed = true; break; }
        if (d === '$' || d === '`') {
          return { error: `"${d}" inside double quotes (shell expansion) is not supported — use single quotes or a plain value` };
        }
        cur += d;
      }
      if (!closed) return { error: 'unterminated double quote' };
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= cmd.length) return { error: 'trailing backslash' };
      cur += cmd[i + 1]; // escaped char is literal (no shell interprets it)
      hasCur = true;
      i++;
      continue;
    }
    if (c === '$') return { error: '"$" (variable/command expansion) is not supported — pass values directly as arguments' };
    if (c === '`') return { error: 'backtick command substitution is not supported' };
    if (c === '\n' || c === '\r') return { error: 'multi-line commands are not supported — run one program at a time' };
    if (c === '#') return { error: 'comments (#) are not supported' };
    if (';|&<>(){}'.includes(c)) {
      return { error: `shell operator "${c}" is not supported — commands run WITHOUT a shell; run one program at a time` };
    }
    if ('*?[]'.includes(c)) {
      return { error: `glob character "${c}" is not supported (no shell expands globs) — pass literal paths or use list_files/search_code` };
    }
    if (c === ' ' || c === '\t') { push(); continue; }
    cur += c;
    hasCur = true;
  }
  push();
  if (argv.length === 0) return { error: 'command is empty' };
  return { argv };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Parses a command string and classifies it.
 * Returns { ok: true, argv, classification: { cls, reason } } or
 *         { ok: false, error }.
 * BLOCKED is returned as a classification (not ok:false) because the argv is
 * known and the refusal reason should reach the model/user.
 */
export function parseAndClassify(cmd) {
  const tok = tokenizeCommand(cmd);
  if (tok.error) return { ok: false, error: tok.error };
  const argv = tok.argv;
  const program = argv[0];
  const args = argv.slice(1);
  const base = path.basename(program);

  // Layer 1: raw-string blocklist (defense in depth; kept from earlier phases).
  const blockedWhy = checkBlocklist(cmd);
  if (blockedWhy) {
    return { ok: true, argv, classification: { cls: CLASSIFICATION.BLOCKED, reason: blockedWhy } };
  }

  // Layer 2: relative path escape in ANY argument (e.g. ../../etc/passwd).
  for (const a of argv) {
    if (a.split('/').includes('..')) {
      return { ok: false, error: `argument "${a}" escapes the repository (".." path segments are refused)` };
    }
  }

  // Layer 3: program denylist.
  if (BLOCKED_PROGRAMS.has(base) || base.startsWith('mkfs')) {
    return {
      ok: true,
      argv,
      classification: { cls: CLASSIFICATION.BLOCKED, reason: `program "${base}" is on the permanent denylist` },
    };
  }

  // Layer 4: structured classification.
  let cls = CLASSIFICATION.REQUIRES_CONFIRMATION;
  let reason = 'unrecognized program — treated as needing confirmation';

  if (base === 'git') {
    const sub = args[0] ?? '';
    const rest = args.slice(1);
    const readonlySub =
      READONLY_GIT_SUBCOMMANDS.has(sub) ||
      ((sub === 'branch' || sub === 'tag' || sub === 'remote') && rest.length === 0) ||
      (sub === 'remote' && rest[0] === '-v');
    if (readonlySub) { cls = CLASSIFICATION.SAFE_READONLY; reason = `git ${sub} is read-only`; }
    else { cls = CLASSIFICATION.SAFE_PROJECT_COMMAND; reason = `git ${sub || '(no subcommand)'} modifies repo state`; }
  } else if (base === 'npm') {
    const a0 = args[0] ?? '';
    if (VERSION_FLAGS.has(a0) || a0 === 'help') { cls = CLASSIFICATION.SAFE_READONLY; reason = 'npm version/help'; }
    else if (NPM_MUTATING_SUBCOMMANDS.has(a0)) { cls = CLASSIFICATION.REQUIRES_CONFIRMATION; reason = `npm ${a0} changes the project/environment`; }
    else { cls = CLASSIFICATION.SAFE_PROJECT_COMMAND; reason = `npm ${a0 || '(default)'} project command`; }
  } else if (base === 'node' || base === 'python' || base === 'python3') {
    if (args.length > 0 && VERSION_FLAGS.has(args[0])) { cls = CLASSIFICATION.SAFE_READONLY; reason = `${base} version/help`; }
    else { cls = CLASSIFICATION.SAFE_PROJECT_COMMAND; reason = `${base} runs project code (no shell involved)`; }
  } else if (base === 'find') {
    if (args.some((a) => FIND_DANGEROUS_FLAGS.has(a) || a.startsWith('-fprint'))) {
      return { ok: true, argv, classification: { cls: CLASSIFICATION.BLOCKED, reason: 'find with delete/exec flags is refused' } };
    }
    cls = CLASSIFICATION.SAFE_READONLY;
    reason = 'find without delete/exec flags';
  } else if (READONLY_PROGRAMS.has(base)) {
    cls = CLASSIFICATION.SAFE_READONLY;
    reason = `"${base}" is a known read-only program`;
  } else if (PROJECT_PROGRAMS.has(base)) {
    cls = CLASSIFICATION.SAFE_PROJECT_COMMAND;
    reason = `"${base}" is a known project tool`;
  }

  // Layer 5: restricted programs always need confirmation — even in auto mode.
  if (RESTRICTED_PROGRAMS.has(base)) {
    cls = CLASSIFICATION.RESTRICTED;
    reason = `program "${base}" is restricted (may modify things outside normal project work)`;
  }

  // Layer 6: absolute/home-path arguments mean intent to touch things outside
  // the repo — downgrade to RESTRICTED (explicit user confirmation required).
  const absArg = args.some((a) => a.startsWith('/') || a === '~' || a.startsWith('~/'));
  if (absArg && cls !== CLASSIFICATION.BLOCKED) {
    cls = CLASSIFICATION.RESTRICTED;
    reason = 'command uses an absolute or home-directory path (outside-repo access requires explicit approval)';
  }

  return { ok: true, argv, classification: { cls, reason } };
}

// ---------------------------------------------------------------------------
// Program resolution (no shell involved)
// ---------------------------------------------------------------------------

/**
 * Resolves the program to an executable path WITHOUT a shell:
 *  - bare names are looked up in the CONTROLLED environment's PATH;
 *  - repo-relative paths (./scripts/build.sh) must resolve inside the repo,
 *    be a regular file and be executable (shebang scripts work via execve);
 *  - absolute program paths are refused (directs to bare name / repo-relative).
 * Throws Error with a clear message on any violation.
 */
export function resolveProgramPath(program, repoRoot, env) {
  if (program.includes('/')) {
    if (path.isAbsolute(program)) {
      throw new Error(`absolute program path "${program}" is not allowed — use the bare command name or a repo-relative path like ./scripts/build.sh`);
    }
    const root = path.resolve(repoRoot);
    const abs = path.resolve(root, program);
    let real;
    try { real = fs.realpathSync(abs); } catch {
      throw new Error(`program "${program}" not found in the repo`);
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`program "${program}" resolves (via symlink) outside the repo`);
    }
    let st;
    try { st = fs.statSync(real); } catch {
      throw new Error(`program "${program}" is not accessible`);
    }
    if (!st.isFile()) throw new Error(`program "${program}" is not a regular file`);
    try { fs.accessSync(real, fs.constants.X_OK); } catch {
      throw new Error(`program "${program}" is not executable (chmod +x needed)`);
    }
    return real;
  }
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const cand = path.join(dir, program);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      if (fs.statSync(cand).isFile()) return fs.realpathSync(cand);
    } catch { /* keep searching */ }
  }
  throw new Error(`program "${program}" not found in PATH of the controlled command environment (repo-local binaries: use ./node_modules/.bin/<name> or "npm run")`);
}

// ---------------------------------------------------------------------------
// Environment hardening
// ---------------------------------------------------------------------------

/** Allowlist of env vars passed to executed commands. Everything else
 *  (GLM_API_KEY and any other secret/setting) is deliberately dropped. */
const COMMAND_ENV_ALLOW = [
  /^PATH$/, /^HOME$/, /^LANG$/, /^LC_[A-Z]+$/, /^TERM$/, /^TMPDIR$/,
  /^TZ$/, /^SHELL$/, /^NO_COLOR$/, /^FORCE_COLOR$/, /^COLORTERM$/,
  /^npm_config_user_agent$/,
];

export function buildCommandEnvironment(baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (COMMAND_ENV_ALLOW.some((re) => re.test(k))) env[k] = v;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin';
  if (!env.HOME) env.HOME = '/tmp';
  return env;
}

// ---------------------------------------------------------------------------
// Secret redaction for logs (never log API keys / tokens)
// ---------------------------------------------------------------------------

export function redactSecrets(s) {
  return String(s).replace(
    /([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;}"']+)/gi,
    (m, key) => `${key}=<redacted>`,
  );
}
