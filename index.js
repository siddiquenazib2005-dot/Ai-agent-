#!/usr/bin/env node
/**
 * my-agent — CLI coding agent (Phases 1–20).
 *
 * Usage:
 *   my-agent --repo <path> --task "<desc>" [options]
 *   my-agent undo --repo <path>       revert the last my-agent checkpoint
 *   my-agent sessions                 list saved sessions
 *
 * Options:
 *   --repo <path>        Target project folder (required)
 *   --task "<desc>"      What the agent should do (required unless --resume)
 *   --mode confirm|auto  confirm = y/N before destructive actions (default);
 *                        auto = skip prompts (but still warns on first-time
 *                        commands per session)
 *   --plan               plan mode: show a plan first, execute after approval
 *   --model <name>       override automatic model routing
 *   --split              force the broad-task splitter
 *   --skip-tests         do not run the repo's test command after changes
 *   --resume <id>        continue a previous session (see: my-agent sessions)
 *   --help, -h           show help
 */

import { loadLlmConfig } from './llmConfig.js';
import {
  runAgentLoop,
  undoLastCheckpoint,
  listSessions,
  createConfirmFunction,
} from './agentLoop.js';
import { startBridge } from './bridge/server.js';
import fs from 'node:fs';
import path from 'node:path';

function printUsage() {
  console.error(`
Usage:
  my-agent --repo <project-path> --task "<task description>" [options]
  my-agent undo --repo <project-path>          revert last checkpoint
  my-agent sessions                            list saved sessions

Options:
  --repo <path>        Target project folder (required)
  --task "<desc>"      What the agent should do (required unless --resume)
  --mode confirm|auto  confirm = y/N before destructive actions (default);
                       auto = no prompts (first-time commands still warned)
  --plan               plan mode: agent shows a plan, waits for "approve"
  --model <name>       override automatic model routing
  --split              force broad-task splitting into sub-tasks
  --skip-tests         skip the automatic post-change test run
  --resume <id>        continue a previous session
  --help, -h           show this help

Examples:
  my-agent --repo ~/projects/jarvis --task "Add input validation to the API"
  my-agent --repo ./JARVIS- --task "Refactor the auth module" --plan
  my-agent undo --repo ~/projects/jarvis
`);
}

/** Minimal dependency-free parser: supports --flag value and --flag=value. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    let key;
    let value;
    const eqIndex = arg.indexOf('=');
    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
    if (key) args[key] = value;
  }
  return args;
}

/** F3: `my-agent undo --repo <path>` — safe, y/N gated. */
async function handleUndo(argv) {
  const args = parseArgs(argv);
  if (!args.repo || typeof args.repo !== 'string') {
    console.error('Error: undo requires --repo <path>');
    process.exit(1);
  }
  const repoAbs = path.resolve(args.repo);
  if (!fs.existsSync(repoAbs)) {
    console.error(`Error: repo path does not exist: ${repoAbs}`);
    process.exit(1);
  }
  console.log(`Undo the last my-agent checkpoint in: ${repoAbs}`);
  console.log('This reverses ONLY the file changes my-agent itself made (edits restored,');
  console.log('agent-created files removed). Your own edits, staged changes, untracked files');
  console.log('and git history are never touched. If a file the agent wrote was changed since,');
  console.log('undo aborts instead of overwriting.');
  const approved = await createConfirmFunction('confirm')(
    'undo last checkpoint',
    'Restore files to their pre-agent state (agent-made changes only).'
  );
  if (!approved) {
    console.log('Aborted — nothing was changed.');
    return;
  }
  try {
    const r = undoLastCheckpoint(repoAbs);
    if (!r.done) {
      console.error('✗ Undo ABORTED — NO changes were made (your data is untouched).');
      if (r.warnings.length) r.warnings.forEach((w) => console.error(`  note: ${w}`));
      if (r.conflicts.length) {
        console.error('  Conflicts detected (files changed after the agent last wrote them):');
        r.conflicts.forEach((c) => console.error(`    - ${c}`));
      }
      console.error('  Resolve these manually, then retry if appropriate.');
      process.exit(1);
    }
    console.log(`✓ Reverted to checkpoint ${r.id.slice(3, 13)} ("${r.label}" created ${r.at}, session ${r.sessionId})`);
    if (r.restored.length) {
      console.log(`  Restored ${r.restored.length} agent-edited file(s):`);
      r.restored.forEach((p) => console.log(`    ~ ${p}`));
    }
    if (r.deleted.length) {
      console.log(`  Removed ${r.deleted.length} agent-created file(s):`);
      r.deleted.forEach((p) => console.log(`    + ${p}`));
    }
    if (r.skipped.length) r.skipped.forEach((p) => console.log(`  skipped: ${p}`));
    if (r.preserved.length) {
      console.log('  Preserved (NOT agent-made — left untouched):');
      r.preserved.forEach((p) => console.log(`    ! ${p}`));
    }
    r.warnings.forEach((w) => console.log(`  note: ${w}`));
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}

/** Phase 12: list saved sessions. */
function handleSessions() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log('No saved sessions yet.');
    return;
  }
  console.log(`Saved sessions (${sessions.length}):
`);
  for (const s of sessions) {
    console.log(`  ${s.id}`);
    console.log(`    repo: ${s.repo} | messages: ${s.messages} | updated: ${s.updatedAt}`);
    console.log(`    task: ${s.task}\n`);
  }
  console.log('Resume one:  my-agent --repo <path> --task "<follow-up>" --resume <session-id>');
}

/** F5: `my-agent bridge [--port N]` — HTTP/SSE bridge for the Android app. */
async function handleBridge(argv) {
  const args = parseArgs(argv);
  let port = 8787;
  if (typeof args.port === 'string' && /^\d+$/.test(args.port)) port = Number(args.port);
  try {
    const srv = await startBridge({ port });
    console.log('my-agent bridge running (local/trusted network only — no auth):');
    console.log(`  events : ${srv.baseUrl}/events   (SSE stream)`);
    console.log(`  health : ${srv.baseUrl}/health`);
    console.log(`  run    : POST ${srv.baseUrl}/run   { repo, task, mode, plan, split }`);
    console.log(`  confirm: POST ${srv.baseUrl}/confirm/:id  { approved: true|false }`);
    console.log('Press Ctrl-C to stop.');
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  const raw = process.argv.slice(2);
  const command = raw[0] && !raw[0].startsWith('--') ? raw[0] : null;
  const argv = command ? raw.slice(1) : raw;

  if (command === 'undo') return handleUndo(argv);
  if (command === 'sessions') return handleSessions();
  if (command === 'bridge') return handleBridge(argv);
  if (command) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const args = parseArgs(argv);
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const missing = [];
  if (!args.repo || typeof args.repo !== 'string') missing.push('--repo');
  if ((!args.task || typeof args.task !== 'string') && !args.resume) missing.push('--task');
  if (missing.length > 0) {
    console.error(`Error: missing required argument(s): ${missing.join(', ')}`);
    printUsage();
    process.exit(1);
  }

  const config = loadLlmConfig(process.env);
  if (config.warning) console.error(`[WARN] ${config.warning}`);

  // Part 2: clear startup validation — a missing key is a friendly error,
  // not a stack trace (set MY_AGENT_DEBUG=1 for the full error).
  if (!config.hasKey) {
    console.error(
      '\nError: no LLM API key configured.\n' +
      'Add ONE of the following to my-agent/.env (see .env.example):\n' +
      '  LLM_API_KEY=<your key>        # primary key for the provider\n' +
      '  LLM_KEYS=<key1>,<key2>        # additional AUTHORIZED keys (failover)\n' +
      'Optional: LLM_BASE_URL, LLM_MODEL, LLM_PROVIDER, LLM_TIMEOUT.\n' +
      'Legacy GLM_API_KEY / GLM_BASE_URL / GLM_MODEL are still supported.'
    );
    process.exit(1);
  }

  const repoAbs = path.resolve(args.repo);
  if (!fs.existsSync(repoAbs) || !fs.statSync(repoAbs).isDirectory()) {
    console.error(`Error: repo path does not exist or is not a directory: ${repoAbs}`);
    process.exit(1);
  }

  const mode = args.mode === undefined ? 'confirm' : args.mode;
  if (mode !== 'confirm' && mode !== 'auto') {
    console.error(`Error: --mode must be "confirm" or "auto" (got: ${mode})`);
    process.exit(1);
  }

  const task = typeof args.task === 'string' ? args.task : 'Continue working on the task from the resumed session.';

  console.log('my-agent — parsed arguments:');
  console.log(`  repo    : ${repoAbs}`);
  console.log(`  task    : ${task}`);
  console.log(`  mode    : ${mode}`);
  console.log(`  plan    : ${args.plan ? 'yes' : 'no'}`);
  console.log(`  model   : ${typeof args.model === 'string' ? args.model : '(auto-routed)'}`);
  console.log(`  resume  : ${typeof args.resume === 'string' ? args.resume : '(new session)'}`);
  console.log(`  primary : ${config.model} | fast: ${config.fastModel}`);
  console.log(`  api     : ${config.baseURL} (${config.providerName}, ${config.keyManager.entries.length} key(s) ${config.keyManager.snapshot().map((k) => k.key).join(', ')}, timeout ${config.timeoutMs}ms)`);

  try {
    const { finalAnswer, iterations, sessionId } = await runAgentLoop(repoAbs, task, {
      mode,
      plan: Boolean(args.plan),
      split: args.split !== undefined,
      modelOverride: typeof args.model === 'string' ? args.model : null,
      resumeSessionId: typeof args.resume === 'string' ? args.resume : null,
      skipTests: args['skip-tests'] !== undefined,
    });
    console.log('\n===== FINAL ANSWER =====');
    console.log(finalAnswer);
    console.log(`(session: ${sessionId})`);
    if (iterations > 0) console.log(`(reported iterations: ${iterations})`);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
