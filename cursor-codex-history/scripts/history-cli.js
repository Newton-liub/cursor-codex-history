#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  EXIT_CODES,
  getConfig,
  ensureHistoryStore,
  openDb,
  reindexHistory,
  querySessions,
  getSessionById,
  getSessionMessages,
  exportSessionToMarkdown,
  archiveSessions,
  recoverSessions,
  deleteSessions,
  summarizeBatch,
} = require('./history-core');

function printHelp() {
  const help = `cursor-codex-history CLI

Usage:
  node scripts/history-cli.js <command> [options]

Commands:
  list
  preview --session-id <id> [--max-messages N]
  export --session-id <id> --output <file.md>
  archive --session-id <id> [--session-id <id> ...] [--force]
  recover --session-id <id> [--session-id <id> ...] [--force]
  delete --session-id <id> [--session-id <id> ...] --force
  reindex

Options:
  --json
  --source <cursor|codex|all>     (list)
  --status <active|archived|all>  (list)
  --limit <N>                     (list)
  --max-messages <N>              (preview)
  --output <path>                 (export)
  --session-id <id>               (repeatable)
  --force                         (archive/recover/delete)
  --history-home <path>
  --cursor-home <path>
  --codex-home <path>
`;
  process.stdout.write(help);
}

function parseArgs(argv) {
  if (argv.length === 0) return { command: null, opts: { help: true } };
  const opts = {
    json: false,
    source: 'all',
    status: 'active',
    limit: 10,
    maxMessages: null,
    output: null,
    sessionIds: [],
    force: false,
    historyHome: null,
    cursorHome: null,
    codexHome: null,
  };
  let command = null;

  const readValue = (idx, flag) => {
    const value = argv[idx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!command && !arg.startsWith('-')) {
      command = arg;
      continue;
    }

    switch (arg) {
      case '--json':
        opts.json = true;
        break;
      case '--source':
        opts.source = readValue(i, arg);
        i += 1;
        break;
      case '--status':
        opts.status = readValue(i, arg);
        i += 1;
        break;
      case '--limit':
        opts.limit = Number.parseInt(readValue(i, arg), 10);
        i += 1;
        break;
      case '--max-messages':
        opts.maxMessages = Number.parseInt(readValue(i, arg), 10);
        i += 1;
        break;
      case '--output':
        opts.output = readValue(i, arg);
        i += 1;
        break;
      case '--session-id':
        opts.sessionIds.push(readValue(i, arg));
        i += 1;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--history-home':
        opts.historyHome = readValue(i, arg);
        i += 1;
        break;
      case '--cursor-home':
        opts.cursorHome = readValue(i, arg);
        i += 1;
        break;
      case '--codex-home':
        opts.codexHome = readValue(i, arg);
        i += 1;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (!command && arg.startsWith('--')) {
          throw new Error(`unknown argument: ${arg}`);
        }
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { command, opts };
}

function emit(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (result.command === 'list') {
    process.stdout.write(`Total: ${result.result.items.length}\n`);
    for (const item of result.result.items) {
      const state = item.archived ? 'archived' : 'active';
      process.stdout.write(`- [${state}] ${item.title}\n`);
      process.stdout.write(`  sessionId: ${item.session_id}\n`);
      process.stdout.write(`  source: ${item.source}, messages: ${item.message_count}\n`);
      process.stdout.write(`  updated: ${item.updated_at || item.created_at || 'N/A'}\n`);
    }
    return;
  }

  if (result.command === 'preview') {
    const s = result.result.session;
    process.stdout.write(`# ${s.title || s.session_id}\n`);
    process.stdout.write(`sessionId: ${s.session_id}\n`);
    process.stdout.write(`source: ${s.source}\n`);
    process.stdout.write(`workspace: ${s.workspace || 'N/A'}\n`);
    process.stdout.write(`archived: ${s.archived ? 'yes' : 'no'}\n`);
    process.stdout.write(`messages: ${result.result.messages.length}\n\n`);
    for (const msg of result.result.messages) {
      process.stdout.write(`[${msg.seq}] ${msg.role}${msg.timestamp ? ` @ ${msg.timestamp}` : ''}\n`);
      process.stdout.write(`${msg.text}\n\n`);
    }
    return;
  }

  if (result.command === 'export') {
    process.stdout.write(`Exported ${result.sessionIds[0]}\n`);
    process.stdout.write(`internal: ${result.result.internalPath}\n`);
    if (result.result.outputPath) process.stdout.write(`output: ${result.result.outputPath}\n`);
    return;
  }

  if (result.command === 'reindex') {
    const r = result.result;
    process.stdout.write(
      `scanned=${r.scanned} imported=${r.imported} updated=${r.updated} unchanged=${r.unchanged} failed=${r.failed}\n`
    );
    return;
  }

  if (['archive', 'recover', 'delete'].includes(result.command)) {
    process.stdout.write(`${result.command} done\n`);
    for (const item of result.result.details || result.result) {
      if (item.ok) process.stdout.write(`- ok: ${item.sessionId}\n`);
      else process.stdout.write(`- failed: ${item.sessionId} (${item.reason})\n`);
    }
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function validateOpts(command, opts) {
  if (!command) return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'missing_command' };

  if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'invalid_limit' };
  }

  if (opts.maxMessages != null && (!Number.isInteger(opts.maxMessages) || opts.maxMessages <= 0)) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'invalid_max_messages' };
  }

  if (!['all', 'cursor', 'codex'].includes(opts.source)) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'invalid_source' };
  }

  if (!['active', 'archived', 'all'].includes(opts.status)) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'invalid_status' };
  }

  if (['preview', 'export', 'archive', 'recover', 'delete'].includes(command) && opts.sessionIds.length === 0) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'missing_session_id' };
  }

  if (command === 'export' && !opts.output) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'missing_output' };
  }

  if (command === 'delete' && !opts.force) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: 'delete_requires_force' };
  }

  if (!['list', 'preview', 'export', 'archive', 'recover', 'delete', 'reindex'].includes(command)) {
    return { ok: false, code: EXIT_CODES.ARG_ERROR, reason: `unknown_command:${command}` };
  }

  return { ok: true };
}

function ensureIndexWarm(db) {
  const row = db.prepare('SELECT COUNT(1) AS count FROM sessions WHERE deleted = 0').get();
  return row && row.count > 0;
}

async function run() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    const result = {
      command: null,
      sessionIds: [],
      result: null,
      exitCode: EXIT_CODES.ARG_ERROR,
      reason: err.message,
      nextAction: 'check_arguments',
    };
    process.stderr.write(`${result.reason}\n`);
    process.exitCode = result.exitCode;
    return;
  }

  const { command, opts } = parsed;
  if (opts.help || !command) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  const validation = validateOpts(command, opts);
  if (!validation.ok) {
    const result = {
      command,
      sessionIds: opts.sessionIds,
      result: null,
      exitCode: validation.code,
      reason: validation.reason,
      nextAction: 'fix_inputs',
    };
    emit(result, opts.json);
    process.exitCode = result.exitCode;
    return;
  }

  const config = getConfig({
    historyHome: opts.historyHome,
    cursorHome: opts.cursorHome,
    codexHome: opts.codexHome,
  });

  await ensureHistoryStore(config);
  const db = openDb(config);

  let result;
  try {
    if (command === 'reindex') {
      const reindex = await reindexHistory(config, db);
      result = {
        command,
        sessionIds: [],
        result: reindex,
        exitCode: reindex.failed > 0 ? EXIT_CODES.PARTIAL : EXIT_CODES.OK,
      };
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    if (!ensureIndexWarm(db)) {
      await reindexHistory(config, db);
    }

    if (command === 'list') {
      const items = querySessions(db, {
        source: opts.source,
        limit: opts.limit,
        status: opts.status,
      });

      result = {
        command,
        sessionIds: [],
        result: { items },
        exitCode: EXIT_CODES.OK,
      };
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    if (command === 'preview') {
      const sessionId = opts.sessionIds[0];
      const session = getSessionById(db, sessionId);
      if (!session) {
        result = {
          command,
          sessionIds: [sessionId],
          result: null,
          exitCode: EXIT_CODES.NOT_FOUND,
          reason: 'session_not_found',
          nextAction: 'run_list',
        };
        emit(result, opts.json);
        process.exitCode = result.exitCode;
        return;
      }

      const messages = getSessionMessages(db, sessionId, opts.maxMessages);
      result = {
        command,
        sessionIds: [sessionId],
        result: { session, messages },
        exitCode: EXIT_CODES.OK,
      };
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    if (command === 'export') {
      const sessionId = opts.sessionIds[0];
      const exported = await exportSessionToMarkdown(config, db, sessionId, opts.output);
      result = {
        command,
        sessionIds: [sessionId],
        result: exported,
        exitCode: exported.code,
      };
      if (!exported.ok) {
        result.reason = exported.reason;
        result.nextAction = 'check_output_path_or_session';
      }
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    if (command === 'archive') {
      const details = await archiveSessions(config, db, opts.sessionIds, opts.force);
      const summary = summarizeBatch(details);
      result = {
        command,
        sessionIds: opts.sessionIds,
        result: { details, summary },
        exitCode: summary.failed > 0 ? EXIT_CODES.PARTIAL : EXIT_CODES.OK,
      };
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    if (command === 'recover') {
      const details = await recoverSessions(config, db, opts.sessionIds, opts.force);
      const summary = summarizeBatch(details);
      result = {
        command,
        sessionIds: opts.sessionIds,
        result: { details, summary },
        exitCode: summary.failed > 0 ? EXIT_CODES.PARTIAL : EXIT_CODES.OK,
      };
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    if (command === 'delete') {
      const deleted = await deleteSessions(config, db, opts.sessionIds, opts.force);
      result = {
        command,
        sessionIds: opts.sessionIds,
        result: deleted,
        exitCode: deleted.code,
      };
      if (!deleted.ok) {
        result.reason = deleted.reason || 'partial_failure';
        result.nextAction = 'check_failed_items';
      }
      emit(result, opts.json);
      process.exitCode = result.exitCode;
      return;
    }

    result = {
      command,
      sessionIds: opts.sessionIds,
      result: null,
      exitCode: EXIT_CODES.ARG_ERROR,
      reason: 'unknown_command',
      nextAction: 'run_help',
    };
    emit(result, opts.json);
    process.exitCode = result.exitCode;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

run().catch((err) => {
  const payload = {
    command: process.argv[2] || null,
    sessionIds: [],
    result: null,
    exitCode: EXIT_CODES.UNKNOWN,
    reason: err && err.message ? err.message : String(err),
    nextAction: 'inspect_logs',
  };
  process.stderr.write(`${payload.reason}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = payload.exitCode;
});
