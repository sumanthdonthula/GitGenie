'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Git, inspect, parsePatch, spansOverlap, alertKey, demoSnapshot } = require('../src/git');

let folder, git;
const original = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join('');

async function write(name, content) { await fs.writeFile(path.join(folder, name), content); }
async function edit(line, value, name = 'code.txt') {
  const lines = (await fs.readFile(path.join(folder, name), 'utf8')).split('\n');
  lines[line - 1] = value;
  await write(name, lines.join('\n'));
}
async function commit(subject, author = 'You') {
  await git.run(['add', '--all']);
  await git.run(['-c', `user.name=${author}`, 'commit', '-m', subject]);
}
async function mainEdit(line = 2, value = 'dev-2 edit') {
  await git.run(['checkout', 'main']);
  await edit(line, value);
  await commit('Update main', 'dev-2');
  await git.run(['checkout', 'feature']);
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-node-'));
  git = new Git(folder);
  await git.run(['init', '-b', 'main']);
  await git.run(['config', 'user.name', 'You']);
  await git.run(['config', 'user.email', 'you@example.test']);
  await write('code.txt', original);
  await commit('Initial commit');
  await git.run(['checkout', '-b', 'feature']);
});
afterEach(async () => { await fs.rm(folder, { recursive: true, force: true }); });

test('clean branch and latest commit', async () => {
  const s = await inspect(folder);
  assert.equal(s.branch, 'feature'); assert.equal(s.base, 'main');
  assert.equal(s.latest.subject, 'Initial commit'); assert.equal(s.overlaps.length, 0);
});

test('same-line overlaps name the real author, without changing HEAD, files, or index', async () => {
  await edit(2, 'Your edit'); await commit('Feature update'); await mainEdit();
  const head = await git.run(['rev-parse', 'HEAD']);
  const index = await fs.readFile(path.join(folder, '.git', 'index'));
  const status = await git.run(['status', '--porcelain=v1', '-z']);
  const s = await inspect(folder);
  assert.deepEqual([s.ahead, s.behind], [1, 1]);
  assert.equal(s.overlaps[0].kind, 'same lines');
  assert.deepEqual(s.overlaps[0].authors, ['dev-2']);
  assert.equal(await git.run(['rev-parse', 'HEAD']), head);
  assert.equal(await git.run(['status', '--porcelain=v1', '-z']), status);
  assert.deepEqual(await fs.readFile(path.join(folder, '.git', 'index')), index);
});

test('unstaged changes participate in the comparison', async () => {
  await mainEdit(); await edit(2, 'Working edit');
  const s = await inspect(folder);
  assert.equal(s.dirtyFiles, 1); assert.equal(s.overlaps[0].kind, 'same lines');
});

test('staged changes are detected even when the worktree restores HEAD', async () => {
  await mainEdit(); await edit(2, 'Staged edit');
  await git.run(['add', 'code.txt']); await edit(2, 'line 2');
  const s = await inspect(folder);
  assert.equal(s.dirtyFiles, 1); assert.equal(s.overlaps[0].kind, 'same lines');
});

test('different line edits are lower-risk same-file alerts', async () => {
  await mainEdit(); await edit(11, 'Far away');
  const s = await inspect(folder);
  assert.equal(s.overlaps[0].kind, 'same file');
  assert.ok(!s.message.includes('possible rebase'));
});

test('identical final content is not reported as overlap', async () => {
  await mainEdit(); await edit(2, 'dev-2 edit'); await commit('Same edit');
  assert.equal((await inspect(folder)).overlaps.length, 0);
});

test('unrelated files do not produce alerts', async () => {
  await mainEdit(); await write('other.txt', 'other'); await commit('Add other');
  const s = await inspect(folder);
  assert.equal(s.overlaps.length, 0); assert.equal(s.behind, 1);
});

test('untracked paths colliding with incoming additions are reported', async () => {
  await git.run(['checkout', 'main']); await write('new.txt', 'main'); await commit('New file', 'dev-2');
  await git.run(['checkout', 'feature']); await write('new.txt', 'local');
  const s = await inspect(folder);
  assert.equal(s.untrackedFiles, 1); assert.equal(s.overlaps[0].kind, 'file collision');
});

test('deletion versus modification is a file collision', async () => {
  await mainEdit(); await fs.unlink(path.join(folder, 'code.txt'));
  assert.equal((await inspect(folder)).overlaps[0].kind, 'file collision');
});

test('binary edits are file collisions', async () => {
  await write('binary.bin', Buffer.from([0, 1])); await commit('Add binary');
  await git.run(['checkout', 'main']); await git.run(['merge', '--ff-only', 'feature']);
  await write('binary.bin', Buffer.from([0, 2])); await commit('Edit binary', 'dev-2');
  await git.run(['checkout', 'feature']); await write('binary.bin', Buffer.from([0, 3]));
  assert.equal((await inspect(folder)).overlaps[0].kind, 'file collision');
});

test('filenames with spaces, brackets, and unicode are literal', async () => {
  const name = 'space [one] café.txt';
  await write(name, 'before\n'); await commit('Add strange name');
  await git.run(['checkout', 'main']); await git.run(['merge', '--ff-only', 'feature']);
  await write(name, 'main\n'); await commit('Edit strange name', 'dev-2');
  await git.run(['checkout', 'feature']); await write(name, 'local\n');
  const s = await inspect(folder);
  assert.equal(s.overlaps[0].path, name); assert.deepEqual(s.overlaps[0].authors, ['dev-2']);
});

test('detached HEAD is supported', async () => {
  await git.run(['checkout', '--detach']);
  assert.match((await inspect(folder)).branch, /^detached @/);
});

test('no default base is actionable and custom branches work', async () => {
  await git.run(['branch', '-m', 'main', 'trunk']);
  assert.equal((await inspect(folder)).base, null);
  assert.equal((await inspect(folder, 'trunk')).base, 'trunk');
  await assert.rejects(inspect(folder, 'not-here'), /wasn’t found/);
  await assert.rejects(inspect(folder, '--help'), /wasn’t found/);
});

test('first commit is not required to open the genie', async () => {
  await git.run(['checkout', '--orphan', 'empty']);
  const s = await inspect(folder);
  assert.equal(s.latest, null); assert.match(s.message, /first commit/);
});

test('same branch comparison has no incoming overlaps', async () => {
  await git.run(['checkout', 'main']); await edit(2, 'Working');
  assert.equal((await inspect(folder)).overlaps.length, 0);
});

test('line span insertion boundaries and structural parsing', () => {
  assert.equal(spansOverlap({ start: 2, count: 1 }, { start: 3, count: 1 }), false);
  assert.equal(spansOverlap({ start: 2, count: 0 }, { start: 3, count: 1 }), true);
  assert.deepEqual(parsePatch('@@ -2 +2,2 @@\n-line\n+edit').spans, [{ start: 2, count: 1 }]);
  assert.equal(parsePatch('Binary files a/x and b/x differ').structural, true);
});

test('alert identity is stable over periodic checks, but changes with base or incoming commit', () => {
  const a = demoSnapshot(); const b = structuredClone(a);
  b.checkedAt = 'later'; assert.equal(alertKey(a), alertKey(b));
  b.base = 'trunk'; assert.notEqual(alertKey(a), alertKey(b));
  b.base = a.base; b.incoming[0].sha = 'another'; assert.notEqual(alertKey(a), alertKey(b));
});
