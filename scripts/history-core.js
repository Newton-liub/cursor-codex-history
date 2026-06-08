'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const EXIT_CODES = {
  OK: 0,
  ARG_ERROR: 2,
  NOT_FOUND: 3,
  PARTIAL: 4,
  UNKNOWN: 5,
};

const ROLE_ALLOWLIST = new Set(['user', 'assistant', 'system', 'developer']);

function nowIso() {
  return new Date().toISOString();
}

function toIso(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function safeTrim(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function cleanTitle(text) {
  let cleaned = safeTrim(text)
    .replace(/<\/?user_query>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length > 96) cleaned = `${cleaned.slice(0, 93)}...`;
  return cleaned;
}

function normalizeText(text) {
  return safeTrim(text).replace(/\s+/g, ' ');
}

function dedupeConsecutiveUserMessages(messages) {
  const deduped = [];
  for (const msg of messages) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.role === 'user' &&
      msg.role === 'user' &&
      normalizeText(prev.text) &&
      normalizeText(prev.text) === normalizeText(msg.text)
    ) {
      continue;
    }
    deduped.push(msg);
  }
  return deduped;
}

function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const chunks = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string') chunks.push(item.text);
    if (typeof item.content === 'string') chunks.push(item.content);
    if (Array.isArray(item.content)) {
      for (const inner of item.content) {
        if (inner && typeof inner === 'object' && typeof inner.text === 'string') {
          chunks.push(inner.text);
        }
      }
    }
  }
  return chunks.join('\n').trim();
}

function extractTextFromCursorMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text.trim();
  return extractTextFromContent(message.content);
}

function extractWorkspaceFromUserInfo(messages) {
  for (const msg of messages) {
    if (msg.role !== 'user' || !msg.text) continue;
    const m = msg.text.match(/Workspace Path:\s*(.+)/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function inferWorkspaceFromCursorProjectSlug(slug) {
  if (!slug || slug.startsWith('tmp-')) return null;
  const parts = slug.split('-');
  if (parts.length < 2) return null;
  if (parts[0] === 'home') return `/home/${parts.slice(1).join('/')}`;
  if (parts[0] === 'Users') return `/Users/${parts.slice(1).join('/')}`;
  return null;
}

function getConfig(overrides = {}) {
  const historyHome = overrides.historyHome || process.env.CURSOR_CODEX_HISTORY_HOME || path.join(os.homedir(), '.cursor-codex-history');
  const cursorHome = overrides.cursorHome || process.env.CURSOR_HOME || path.join(os.homedir(), '.cursor');
  const codexHome = overrides.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  return {
    historyHome,
    cursorHome,
    codexHome,
    rawDir: path.join(historyHome, 'raw'),
    normalizedDir: path.join(historyHome, 'normalized'),
    exportsDir: path.join(historyHome, 'exports'),
    archiveDir: path.join(historyHome, 'archive'),
    archiveNormalizedDir: path.join(historyHome, 'archive', 'normalized'),
    archiveExportsDir: path.join(historyHome, 'archive', 'exports'),
    dbPath: path.join(historyHome, 'index.sqlite'),
    cursorProjectsDir: path.join(cursorHome, 'projects'),
    codexSessionsDir: path.join(codexHome, 'sessions'),
  };
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function ensureHistoryStore(config) {
  await Promise.all([
    ensureDir(config.historyHome),
    ensureDir(path.join(config.rawDir, 'cursor')),
    ensureDir(path.join(config.rawDir, 'codex')),
    ensureDir(path.join(config.normalizedDir, 'cursor')),
    ensureDir(path.join(config.normalizedDir, 'codex')),
    ensureDir(config.exportsDir),
    ensureDir(path.join(config.archiveNormalizedDir, 'cursor')),
    ensureDir(path.join(config.archiveNormalizedDir, 'codex')),
    ensureDir(config.archiveExportsDir),
  ]);
}

function openDb(config) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      workspace TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      normalized_path TEXT,
      raw_path TEXT,
      export_path TEXT,
      source_path TEXT,
      file_hash TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT,
      meta_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);

    CREATE TABLE IF NOT EXISTS raw_files (
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      raw_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      session_id TEXT,
      imported_at TEXT NOT NULL,
      PRIMARY KEY(source, source_path)
    );

    CREATE TABLE IF NOT EXISTS deleted_sessions (
      session_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );
  `);

  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(session_id, role, text);');
  } catch {
    // FTS may not be available in some sqlite builds; keep core functionality working.
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages_fts (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
    `);
  }

  return db;
}

async function walkFiles(rootDir, predicate) {
  const files = [];
  try {
    await fsp.access(rootDir, fs.constants.R_OK);
  } catch {
    return files;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        if (!predicate || predicate(abs)) files.push(abs);
      }
    }
  }
  files.sort();
  return files;
}

function isCursorTranscriptPath(absPath) {
  if (!absPath.endsWith('.jsonl')) return false;
  const parts = absPath.split(path.sep);
  const idx = parts.lastIndexOf('agent-transcripts');
  return idx > 0 && parts.length >= idx + 3;
}

function isCodexRolloutPath(absPath) {
  return absPath.endsWith('.jsonl') && /rollout-.*\.jsonl$/.test(path.basename(absPath));
}

async function discoverSourceFiles(config) {
  const [cursorFiles, codexFiles] = await Promise.all([
    walkFiles(config.cursorProjectsDir, isCursorTranscriptPath),
    walkFiles(config.codexSessionsDir, isCodexRolloutPath),
  ]);

  return {
    cursor: cursorFiles,
    codex: codexFiles,
  };
}

async function fileHash(absPath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(absPath);
  stream.on('data', (chunk) => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

async function copyRawFile(config, source, sourcePath, hashValue, sessionId) {
  const ext = path.extname(sourcePath) || '.jsonl';
  const rawFile = path.join(config.rawDir, source, `${sessionId}-${hashValue.slice(0, 12)}${ext}`);
  try {
    await fsp.access(rawFile, fs.constants.F_OK);
    return rawFile;
  } catch {
    await fsp.copyFile(sourcePath, rawFile);
    return rawFile;
  }
}

async function writeNormalizedSession(config, session) {
  const target = path.join(config.normalizedDir, session.source, `${session.session_id}.jsonl`);
  await ensureDir(path.dirname(target));

  const lines = [];
  lines.push(JSON.stringify({
    type: 'session',
    session_id: session.session_id,
    source: session.source,
    workspace: session.workspace || null,
    title: session.title || session.session_id,
    created_at: session.created_at,
    updated_at: session.updated_at,
    message_count: session.messages.length,
    source_path: session.source_path,
  }));

  for (const msg of session.messages) {
    lines.push(JSON.stringify({
      type: 'message',
      seq: msg.seq,
      role: msg.role,
      text: msg.text,
      timestamp: msg.timestamp || null,
      meta: msg.meta || {},
    }));
  }

  const tempPath = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tempPath, `${lines.join('\n')}\n`, 'utf8');
  await fsp.rename(tempPath, target);
  return target;
}

function buildTitle(messages, fallback) {
  for (const role of ['user', 'assistant', 'developer', 'system']) {
    const found = messages.find((m) => m.role === role && safeTrim(m.text));
    if (found) {
      const title = cleanTitle(found.text);
      if (title) return title;
    }
  }
  return fallback;
}

function parseCursorTranscriptLines(lines, sourcePath) {
  const messages = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const role = safeTrim(obj.role);
    if (!ROLE_ALLOWLIST.has(role)) continue;

    const text = extractTextFromCursorMessage(obj.message);
    if (!safeTrim(text)) continue;

    messages.push({
      role,
      text,
      timestamp: toIso(obj.timestamp) || null,
      meta: {},
    });
  }

  const deduped = dedupeConsecutiveUserMessages(messages).map((m, idx) => ({
    ...m,
    seq: idx + 1,
  }));

  const parts = sourcePath.split(path.sep);
  const idx = parts.lastIndexOf('agent-transcripts');
  const projectSlug = idx > 1 ? parts[idx - 1] : null;
  const sessionId = path.basename(sourcePath, '.jsonl');
  const workspaceFromPath = inferWorkspaceFromCursorProjectSlug(projectSlug);
  const workspace = extractWorkspaceFromUserInfo(deduped) || workspaceFromPath;

  return {
    source: 'cursor',
    session_id: sessionId,
    workspace,
    title: buildTitle(deduped, sessionId),
    messages: deduped,
    source_path: sourcePath,
  };
}

async function parseCursorTranscriptFile(sourcePath) {
  const [raw, stats] = await Promise.all([
    fsp.readFile(sourcePath, 'utf8'),
    fsp.stat(sourcePath),
  ]);

  const parsed = parseCursorTranscriptLines(raw.split(/\r?\n/), sourcePath);
  const createdAt = stats.birthtimeMs > 0 ? new Date(stats.birthtimeMs).toISOString() : new Date(stats.mtimeMs).toISOString();
  const updatedAt = new Date(stats.mtimeMs).toISOString();

  return {
    ...parsed,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseCodexRolloutLines(lines, sourcePath) {
  const messages = [];
  let sessionMeta = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = toIso(obj.timestamp);
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
      sessionMeta = obj.payload;
      continue;
    }

    if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
      const payload = obj.payload;
      if (payload.type !== 'message') continue;

      const role = safeTrim(payload.role);
      if (!ROLE_ALLOWLIST.has(role)) continue;

      const text = extractTextFromContent(payload.content);
      if (!safeTrim(text)) continue;

      messages.push({
        role,
        text,
        timestamp: ts || toIso(payload.timestamp) || null,
        meta: {},
      });
    }
  }

  const deduped = dedupeConsecutiveUserMessages(messages).map((m, idx) => ({
    ...m,
    seq: idx + 1,
  }));

  const sessionId =
    safeTrim(sessionMeta && sessionMeta.id) ||
    path.basename(sourcePath, '.jsonl').replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');

  const createdAt = toIso(sessionMeta && sessionMeta.timestamp) || firstTimestamp;
  const updatedAt = lastTimestamp || createdAt;

  return {
    source: 'codex',
    session_id: sessionId,
    workspace: safeTrim(sessionMeta && sessionMeta.cwd) || null,
    title: buildTitle(deduped, sessionId),
    messages: deduped,
    source_path: sourcePath,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

async function parseCodexRolloutFile(sourcePath) {
  const [raw, stats] = await Promise.all([
    fsp.readFile(sourcePath, 'utf8'),
    fsp.stat(sourcePath),
  ]);

  const parsed = parseCodexRolloutLines(raw.split(/\r?\n/), sourcePath);
  const fallbackCreated = stats.birthtimeMs > 0 ? new Date(stats.birthtimeMs).toISOString() : new Date(stats.mtimeMs).toISOString();
  const fallbackUpdated = new Date(stats.mtimeMs).toISOString();

  return {
    ...parsed,
    created_at: parsed.created_at || fallbackCreated,
    updated_at: parsed.updated_at || fallbackUpdated,
  };
}

function isSessionDeleted(db, sessionId) {
  const row = db.prepare('SELECT 1 AS exists_flag FROM deleted_sessions WHERE session_id = ?').get(sessionId);
  return Boolean(row);
}

function writeSessionToIndex(db, session, fileMeta) {
  const importedAt = nowIso();

  db.prepare(
    `INSERT INTO sessions (
      session_id, source, workspace, title, created_at, updated_at, normalized_path, raw_path,
      export_path, source_path, file_hash, archived, deleted, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
      COALESCE((SELECT export_path FROM sessions WHERE session_id = ?), ?),
      ?, ?, COALESCE((SELECT archived FROM sessions WHERE session_id = ?), 0), 0, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      source=excluded.source,
      workspace=excluded.workspace,
      title=excluded.title,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at,
      normalized_path=excluded.normalized_path,
      raw_path=excluded.raw_path,
      source_path=excluded.source_path,
      file_hash=excluded.file_hash,
      deleted=0,
      imported_at=excluded.imported_at`
  ).run(
    session.session_id,
    session.source,
    session.workspace,
    session.title,
    session.created_at,
    session.updated_at,
    fileMeta.normalizedPath,
    fileMeta.rawPath,
    session.session_id,
    path.join(fileMeta.exportsDir, `${session.session_id}.md`),
    session.source_path,
    fileMeta.fileHash,
    session.session_id,
    importedAt
  );

  db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.session_id);
  db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(session.session_id);

  const insertMessage = db.prepare(
    'INSERT INTO messages (session_id, seq, role, text, timestamp, meta_json) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertFts = db.prepare('INSERT INTO messages_fts (session_id, role, text) VALUES (?, ?, ?)');

  for (const msg of session.messages) {
    insertMessage.run(
      session.session_id,
      msg.seq,
      msg.role,
      msg.text,
      msg.timestamp || null,
      JSON.stringify(msg.meta || {})
    );
    try {
      insertFts.run(session.session_id, msg.role, msg.text);
    } catch {
      // FTS disabled or unavailable.
    }
  }

  db.prepare(
    `INSERT INTO raw_files (source, source_path, raw_path, file_hash, size_bytes, mtime_ms, session_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_path) DO UPDATE SET
       raw_path=excluded.raw_path,
       file_hash=excluded.file_hash,
       size_bytes=excluded.size_bytes,
       mtime_ms=excluded.mtime_ms,
       session_id=excluded.session_id,
       imported_at=excluded.imported_at`
  ).run(
    session.source,
    session.source_path,
    fileMeta.rawPath,
    fileMeta.fileHash,
    fileMeta.sizeBytes,
    fileMeta.mtimeMs,
    session.session_id,
    importedAt
  );
}

async function importSourceFile(config, db, source, sourcePath) {
  const stat = await fsp.stat(sourcePath);
  const hashValue = await fileHash(sourcePath);

  const existing = db
    .prepare('SELECT file_hash, session_id FROM raw_files WHERE source = ? AND source_path = ?')
    .get(source, sourcePath);

  if (existing && existing.file_hash === hashValue) {
    return { status: 'unchanged', source, sourcePath, sessionId: existing.session_id || null };
  }

  const parsed = source === 'cursor'
    ? await parseCursorTranscriptFile(sourcePath)
    : await parseCodexRolloutFile(sourcePath);

  if (!parsed.session_id) {
    return { status: 'skipped', source, sourcePath, reason: 'no_session_id' };
  }

  if (isSessionDeleted(db, parsed.session_id)) {
    return { status: 'deleted_skipped', source, sourcePath, sessionId: parsed.session_id };
  }

  const rawPath = await copyRawFile(config, source, sourcePath, hashValue, parsed.session_id);
  const normalizedPath = await writeNormalizedSession(config, parsed);

  writeSessionToIndex(db, parsed, {
    rawPath,
    normalizedPath,
    fileHash: hashValue,
    sizeBytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    exportsDir: config.exportsDir,
  });

  return {
    status: existing ? 'updated' : 'imported',
    source,
    sourcePath,
    sessionId: parsed.session_id,
    messageCount: parsed.messages.length,
  };
}

async function reindexHistory(config, db, options = {}) {
  const discovered = await discoverSourceFiles(config);
  const results = {
    scanned: discovered.cursor.length + discovered.codex.length,
    imported: 0,
    updated: 0,
    unchanged: 0,
    deleted_skipped: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  const all = [
    ...discovered.cursor.map((p) => ({ source: 'cursor', path: p })),
    ...discovered.codex.map((p) => ({ source: 'codex', path: p })),
  ];

  for (const item of all) {
    try {
      const one = await importSourceFile(config, db, item.source, item.path);
      results.details.push(one);
      if (one.status in results) results[one.status] += 1;
      else results.skipped += 1;
    } catch (err) {
      results.failed += 1;
      results.details.push({
        status: 'failed',
        source: item.source,
        sourcePath: item.path,
        reason: err && err.message ? err.message : String(err),
      });
      if (options.stopOnError) throw err;
    }
  }

  return results;
}

function querySessions(db, { source = 'all', limit = 10, status = 'active' } = {}) {
  const clauses = ['deleted = 0'];
  const params = [];

  if (source !== 'all') {
    clauses.push('source = ?');
    params.push(source);
  }

  if (status === 'active') clauses.push('archived = 0');
  if (status === 'archived') clauses.push('archived = 1');

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT
         s.session_id,
         s.source,
         s.workspace,
         COALESCE(NULLIF(TRIM(s.title), ''), s.session_id) AS title,
         s.created_at,
         s.updated_at,
         s.archived,
         s.normalized_path,
         COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.session_id
       ${whereSql}
       GROUP BY s.session_id
       ORDER BY datetime(COALESCE(s.updated_at, s.created_at)) DESC
       LIMIT ?`
    )
    .all(...params, limit);
}

function getSessionById(db, sessionId) {
  return db
    .prepare(
      `SELECT
        session_id, source, workspace, title, created_at, updated_at, archived,
        normalized_path, raw_path, export_path, source_path
       FROM sessions
       WHERE session_id = ? AND deleted = 0`
    )
    .get(sessionId);
}

function getSessionMessages(db, sessionId, maxMessages = null) {
  if (maxMessages && Number.isInteger(maxMessages) && maxMessages > 0) {
    return db
      .prepare(
        `SELECT seq, role, text, timestamp, meta_json
         FROM messages
         WHERE session_id = ?
         ORDER BY seq ASC
         LIMIT ?`
      )
      .all(sessionId, maxMessages)
      .map((m) => ({
        ...m,
        meta: safeParseJson(m.meta_json),
      }));
  }

  return db
    .prepare(
      `SELECT seq, role, text, timestamp, meta_json
       FROM messages
       WHERE session_id = ?
       ORDER BY seq ASC`
    )
    .all(sessionId)
    .map((m) => ({
      ...m,
      meta: safeParseJson(m.meta_json),
    }));
}

function safeParseJson(text) {
  if (!text || typeof text !== 'string') return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function ensurePathInside(baseDir, targetPath) {
  const baseResolved = path.resolve(baseDir);
  const targetResolved = path.resolve(targetPath);
  return targetResolved === baseResolved || targetResolved.startsWith(`${baseResolved}${path.sep}`);
}

function toMarkdown(session, messages) {
  const lines = [];
  lines.push(`# Session ${session.session_id}`);
  lines.push('');
  lines.push(`- Source: ${session.source}`);
  lines.push(`- Title: ${session.title || session.session_id}`);
  lines.push(`- Workspace: ${session.workspace || 'N/A'}`);
  lines.push(`- Created At: ${session.created_at || 'N/A'}`);
  lines.push(`- Updated At: ${session.updated_at || 'N/A'}`);
  lines.push(`- Archived: ${session.archived ? 'yes' : 'no'}`);
  lines.push(`- Messages: ${messages.length}`);
  lines.push('');

  for (const msg of messages) {
    lines.push(`## ${msg.seq}. ${msg.role.toUpperCase()}${msg.timestamp ? ` (${msg.timestamp})` : ''}`);
    lines.push('');
    lines.push('```text');
    lines.push((msg.text || '').replace(/```/g, '` ` `'));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

async function exportSessionToMarkdown(config, db, sessionId, outputPath) {
  const session = getSessionById(db, sessionId);
  if (!session) {
    return { ok: false, code: EXIT_CODES.NOT_FOUND, reason: 'session_not_found' };
  }

  const messages = getSessionMessages(db, sessionId);
  const markdown = toMarkdown(session, messages);

  await ensureDir(config.exportsDir);
  const internalPath = path.join(config.exportsDir, `${sessionId}.md`);
  await fsp.writeFile(internalPath, markdown, 'utf8');

  let resolvedOutput = null;
  if (outputPath) {
    const cwd = process.cwd();
    resolvedOutput = path.isAbsolute(outputPath)
      ? path.resolve(outputPath)
      : path.resolve(cwd, outputPath);

    if (!ensurePathInside(cwd, resolvedOutput)) {
      return {
        ok: false,
        code: EXIT_CODES.ARG_ERROR,
        reason: 'output_path_outside_cwd',
        internalPath,
      };
    }

    await ensureDir(path.dirname(resolvedOutput));
    await fsp.writeFile(resolvedOutput, markdown, 'utf8');
  }

  db.prepare('UPDATE sessions SET export_path = ?, updated_at = ? WHERE session_id = ?')
    .run(internalPath, nowIso(), sessionId);

  return {
    ok: true,
    code: EXIT_CODES.OK,
    sessionId,
    internalPath,
    outputPath: resolvedOutput,
    messageCount: messages.length,
  };
}

async function moveIfExists(source, target, force = false) {
  try {
    await fsp.access(source, fs.constants.F_OK);
  } catch {
    return { moved: false, reason: 'missing_source' };
  }

  await ensureDir(path.dirname(target));

  try {
    if (force) {
      await fsp.rm(target, { recursive: false, force: true });
    } else {
      await fsp.access(target, fs.constants.F_OK);
      return { moved: false, reason: 'target_exists' };
    }
  } catch {
    // target not existing; continue.
  }

  await fsp.rename(source, target);
  return { moved: true };
}

async function archiveSessions(config, db, sessionIds, force = false) {
  const results = [];

  for (const sessionId of sessionIds) {
    const session = getSessionById(db, sessionId);
    if (!session) {
      results.push({ sessionId, ok: false, reason: 'not_found' });
      continue;
    }
    if (session.archived) {
      results.push({ sessionId, ok: false, reason: 'already_archived' });
      continue;
    }

    const targetNormalized = path.join(config.archiveNormalizedDir, session.source, `${sessionId}.jsonl`);
    const targetExport = path.join(config.archiveExportsDir, `${sessionId}.md`);

    const moveNorm = await moveIfExists(session.normalized_path, targetNormalized, force);
    if (!moveNorm.moved && moveNorm.reason === 'target_exists') {
      results.push({ sessionId, ok: false, reason: 'normalized_target_exists' });
      continue;
    }

    const exportSource = session.export_path || path.join(config.exportsDir, `${sessionId}.md`);
    await moveIfExists(exportSource, targetExport, force);

    db.prepare(
      'UPDATE sessions SET archived = 1, normalized_path = ?, export_path = ?, updated_at = ? WHERE session_id = ?'
    ).run(targetNormalized, targetExport, nowIso(), sessionId);

    results.push({ sessionId, ok: true, archived: true });
  }

  return results;
}

async function recoverSessions(config, db, sessionIds, force = false) {
  const results = [];

  for (const sessionId of sessionIds) {
    const session = getSessionById(db, sessionId);
    if (!session) {
      results.push({ sessionId, ok: false, reason: 'not_found' });
      continue;
    }
    if (!session.archived) {
      results.push({ sessionId, ok: false, reason: 'not_archived' });
      continue;
    }

    const targetNormalized = path.join(config.normalizedDir, session.source, `${sessionId}.jsonl`);
    const targetExport = path.join(config.exportsDir, `${sessionId}.md`);

    const recoverNorm = await moveIfExists(session.normalized_path, targetNormalized, force);
    if (!recoverNorm.moved && recoverNorm.reason === 'target_exists') {
      results.push({ sessionId, ok: false, reason: 'normalized_target_exists' });
      continue;
    }

    const exportSource = session.export_path || path.join(config.archiveExportsDir, `${sessionId}.md`);
    await moveIfExists(exportSource, targetExport, force);

    db.prepare(
      'UPDATE sessions SET archived = 0, normalized_path = ?, export_path = ?, updated_at = ? WHERE session_id = ?'
    ).run(targetNormalized, targetExport, nowIso(), sessionId);

    results.push({ sessionId, ok: true, archived: false });
  }

  return results;
}

async function deleteSessions(config, db, sessionIds, force = false) {
  if (!force) {
    return {
      ok: false,
      code: EXIT_CODES.ARG_ERROR,
      reason: 'delete_requires_force',
      deletedFiles: 0,
      removedHistoryLines: 0,
      details: [],
    };
  }

  const details = [];
  let deletedFiles = 0;

  for (const sessionId of sessionIds) {
    const session = getSessionById(db, sessionId);
    if (!session) {
      details.push({ sessionId, ok: false, reason: 'not_found' });
      continue;
    }

    const filesToDelete = new Set([
      session.normalized_path,
      session.export_path,
      path.join(config.normalizedDir, session.source, `${sessionId}.jsonl`),
      path.join(config.archiveNormalizedDir, session.source, `${sessionId}.jsonl`),
      path.join(config.exportsDir, `${sessionId}.md`),
      path.join(config.archiveExportsDir, `${sessionId}.md`),
    ].filter(Boolean));

    const rawRows = db.prepare('SELECT raw_path FROM raw_files WHERE session_id = ?').all(sessionId);
    for (const row of rawRows) filesToDelete.add(row.raw_path);

    for (const filePath of filesToDelete) {
      try {
        await fsp.rm(filePath, { force: true });
        deletedFiles += 1;
      } catch {
        // keep going; deletion is best-effort on files.
      }
    }

    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM raw_files WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    db.prepare(
      'INSERT INTO deleted_sessions (session_id, deleted_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET deleted_at = excluded.deleted_at'
    ).run(sessionId, nowIso());

    details.push({ sessionId, ok: true });
  }

  return {
    ok: details.every((d) => d.ok),
    code: details.some((d) => !d.ok) ? EXIT_CODES.PARTIAL : EXIT_CODES.OK,
    deletedFiles,
    removedHistoryLines: 0,
    details,
  };
}

function summarizeBatch(results) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return { ok, failed, total: results.length };
}

module.exports = {
  EXIT_CODES,
  getConfig,
  ensureHistoryStore,
  openDb,
  discoverSourceFiles,
  importSourceFile,
  reindexHistory,
  querySessions,
  getSessionById,
  getSessionMessages,
  exportSessionToMarkdown,
  archiveSessions,
  recoverSessions,
  deleteSessions,
  summarizeBatch,
  parseCursorTranscriptLines,
  parseCodexRolloutLines,
  dedupeConsecutiveUserMessages,
};
