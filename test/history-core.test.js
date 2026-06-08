'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureHistoryStore,
  openDb,
  reindexHistory,
  querySessions,
  getSessionById,
  exportSessionToMarkdown,
  archiveSessions,
  recoverSessions,
  deleteSessions,
  parseCursorTranscriptLines,
  parseCodexRolloutLines,
} = require('../scripts/history-core');

async function mkTmpDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('parseCursorTranscriptLines removes consecutive duplicate user messages', () => {
  const sourcePath = '/tmp/cursor/projects/home-liu-work/agent-transcripts/abc/abc.jsonl';
  const lines = [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } }),
  ];

  const parsed = parseCursorTranscriptLines(lines, sourcePath);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].text, 'hello');
  assert.equal(parsed.messages[1].text, 'world');
  assert.equal(parsed.source, 'cursor');
});

test('parseCodexRolloutLines extracts response_item messages', () => {
  const sourcePath = '/tmp/.codex/sessions/2026/04/01/rollout-2026-04-01T20-00-00-019x-test.jsonl';
  const lines = [
    JSON.stringify({
      timestamp: '2026-04-01T09:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sess-codex-1', timestamp: '2026-04-01T09:00:00.000Z', cwd: '/repo/demo' },
    }),
    JSON.stringify({
      timestamp: '2026-04-01T09:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'question' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-01T09:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    }),
  ];

  const parsed = parseCodexRolloutLines(lines, sourcePath);
  assert.equal(parsed.session_id, 'sess-codex-1');
  assert.equal(parsed.workspace, '/repo/demo');
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[1].role, 'assistant');
});

test('reindex + export + archive + recover + delete workflow', async () => {
  const root = await mkTmpDir('cch-test-');
  const cursorHome = path.join(root, 'cursor-home');
  const codexHome = path.join(root, 'codex-home');
  const historyHome = path.join(root, 'history-home');
  const workDir = path.join(root, 'work');

  await fsp.mkdir(workDir, { recursive: true });

  const cursorTranscript = path.join(
    cursorHome,
    'projects',
    'home-liu-demo',
    'agent-transcripts',
    'cursor-session-1',
    'cursor-session-1.jsonl'
  );
  await fsp.mkdir(path.dirname(cursorTranscript), { recursive: true });
  await fsp.writeFile(
    cursorTranscript,
    [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] } }),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } }),
    ].join('\n') + '\n',
    'utf8'
  );

  const codexRollout = path.join(
    codexHome,
    'sessions',
    '2026',
    '04',
    '01',
    'rollout-2026-04-01T20-00-00-019d-test-codex-session-1.jsonl'
  );
  await fsp.mkdir(path.dirname(codexRollout), { recursive: true });
  await fsp.writeFile(
    codexRollout,
    [
      JSON.stringify({
        timestamp: '2026-04-01T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-session-1', timestamp: '2026-04-01T09:00:00.000Z', cwd: '/home/example/demo' },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T09:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'how are you' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T09:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'fine' }],
        },
      }),
    ].join('\n') + '\n',
    'utf8'
  );

  const config = {
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

  await ensureHistoryStore(config);
  const db = openDb(config);

  try {
    const reindexed = await reindexHistory(config, db);
    assert.equal(reindexed.imported, 2);

    const listed = querySessions(db, { source: 'all', status: 'active', limit: 20 });
    assert.equal(listed.length, 2);

    const cursorSession = listed.find((s) => s.session_id === 'cursor-session-1');
    assert.ok(cursorSession);

    const oldCwd = process.cwd();
    process.chdir(workDir);
    try {
      const exported = await exportSessionToMarkdown(config, db, 'cursor-session-1', './exports/cursor-session-1.md');
      assert.equal(exported.ok, true);
      assert.equal(fs.existsSync(exported.outputPath), true);
    } finally {
      process.chdir(oldCwd);
    }

    const archived = await archiveSessions(config, db, ['cursor-session-1'], false);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].ok, true);

    let session = getSessionById(db, 'cursor-session-1');
    assert.equal(session.archived, 1);

    const recovered = await recoverSessions(config, db, ['cursor-session-1'], false);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].ok, true);

    session = getSessionById(db, 'cursor-session-1');
    assert.equal(session.archived, 0);

    const deleted = await deleteSessions(config, db, ['cursor-session-1'], true);
    assert.equal(deleted.ok, true);

    session = getSessionById(db, 'cursor-session-1');
    assert.equal(session, undefined);

    await reindexHistory(config, db);
    session = getSessionById(db, 'cursor-session-1');
    assert.equal(session, undefined);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
});
