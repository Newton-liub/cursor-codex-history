#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  getConfig,
  ensureHistoryStore,
  openDb,
  reindexHistory,
} = require('./history-core');

function parseArgs(argv) {
  const opts = {
    once: false,
    fullScanMinutes: 10,
    debounceMs: 2000,
    json: false,
    historyHome: null,
    cursorHome: null,
    codexHome: null,
  };

  const readValue = (idx, flag) => {
    const value = argv[idx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--once':
        opts.once = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--full-scan-minutes':
        opts.fullScanMinutes = Number.parseInt(readValue(i, arg), 10);
        i += 1;
        break;
      case '--debounce-ms':
        opts.debounceMs = Number.parseInt(readValue(i, arg), 10);
        i += 1;
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
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  process.stdout.write(`cursor-codex-history sync-daemon

Usage:
  node scripts/sync-daemon.js [options]

Options:
  --once
  --json
  --full-scan-minutes <N>   (default: 10)
  --debounce-ms <N>         (default: 2000)
  --history-home <path>
  --cursor-home <path>
  --codex-home <path>
`);
}

function logger(asJson, payload) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    const ts = new Date().toISOString();
    process.stdout.write(`[${ts}] ${payload.level}: ${payload.message}\n`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  if (!Number.isInteger(opts.fullScanMinutes) || opts.fullScanMinutes <= 0) {
    throw new Error('full-scan-minutes must be a positive integer');
  }

  if (!Number.isInteger(opts.debounceMs) || opts.debounceMs < 100) {
    throw new Error('debounce-ms must be an integer >= 100');
  }

  const config = getConfig({
    historyHome: opts.historyHome,
    cursorHome: opts.cursorHome,
    codexHome: opts.codexHome,
  });

  await ensureHistoryStore(config);
  const db = openDb(config);

  const runScan = async (reason) => {
    const startedAt = Date.now();
    try {
      const result = await reindexHistory(config, db);
      logger(opts.json, {
        level: 'info',
        message: `scan completed (${reason})`,
        reason,
        durationMs: Date.now() - startedAt,
        result: {
          scanned: result.scanned,
          imported: result.imported,
          updated: result.updated,
          unchanged: result.unchanged,
          failed: result.failed,
        },
      });
    } catch (err) {
      logger(opts.json, {
        level: 'error',
        message: `scan failed (${reason})`,
        reason,
        durationMs: Date.now() - startedAt,
        error: err && err.message ? err.message : String(err),
      });
    }
  };

  await runScan('startup');
  if (opts.once) {
    try {
      db.close();
    } catch {
      // ignore
    }
    return;
  }

  const watchers = [];
  const roots = [config.cursorProjectsDir, config.codexSessionsDir];

  let scanning = false;
  let rerunAfter = false;
  let debounceTimer = null;

  const scheduleScan = (reason) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (scanning) {
        rerunAfter = true;
        return;
      }
      scanning = true;
      await runScan(reason);
      scanning = false;
      if (rerunAfter) {
        rerunAfter = false;
        scheduleScan('deferred');
      }
    }, opts.debounceMs);
  };

  for (const root of roots) {
    try {
      fs.accessSync(root, fs.constants.R_OK);
    } catch {
      logger(opts.json, { level: 'warn', message: `watch root missing: ${root}` });
      continue;
    }

    try {
      const watcher = fs.watch(root, { recursive: true }, () => {
        scheduleScan('watch-event');
      });
      watchers.push(watcher);
      logger(opts.json, { level: 'info', message: `watching: ${root}` });
    } catch (err) {
      logger(opts.json, {
        level: 'warn',
        message: `watch failed for ${root}, relying on periodic scan`,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  const intervalMs = opts.fullScanMinutes * 60 * 1000;
  const interval = setInterval(() => {
    scheduleScan('periodic-full-scan');
  }, intervalMs);

  const shutdown = () => {
    clearInterval(interval);
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    logger(opts.json, { level: 'info', message: 'sync daemon stopped' });
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger(opts.json, {
    level: 'info',
    message: 'sync daemon started',
    mode: 'watch+periodic',
    fullScanMinutes: opts.fullScanMinutes,
    debounceMs: opts.debounceMs,
  });
}

main().catch((err) => {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 5;
});
