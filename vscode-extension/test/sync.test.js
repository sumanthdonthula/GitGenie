'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Git, inspect } = require('../src/git');
const { syncPlan, cleanBranch, pullAndRebase, resumeRebase, operationState, fetchRemote } = require('../src/sync');

let root, source, client, remote, git, upstream;
const original = 'first line\nbase calculation\nthird line\n';

async function commit(repo, name, content, subject) {
  await fs.writeFile(path.join(repo, name), content);
  const g = new Git(repo);
  await g.run(['add', '.']);
  await g.run(['commit', '-m', subject]);
}
async function pushMain(name = 'remote.txt', content = 'from teammate\n') {
  await commit(source, name, content, 'Teammate update');
  await upstream.run(['push', 'origin', 'main']);
}
async function head() { return (await git.run(['rev-parse', 'HEAD'])).trim(); }
async function defaultPlan() { return syncPlan(client, 'main'); }
async function createConflict() {
  await commit(client, 'code.txt', original.replace('base calculation', 'your calculation'), 'Feature calculation');
  await pushMain('code.txt', original.replace('base calculation', 'teammate calculation'));
  return pullAndRebase(client, await defaultPlan());
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-sync-'));
  source = path.join(root, 'source'); client = path.join(root, 'client'); remote = path.join(root, 'remote.git');
  await fs.mkdir(source);
  upstream = new Git(source);
  await upstream.run(['init', '-b', 'main']);
  await upstream.run(['config', 'user.name', 'dev-2']);
  await upstream.run(['config', 'user.email', 'dev2@example.test']);
  await upstream.run(['config', 'commit.gpgsign', 'false']);
  await upstream.run(['config', 'core.autocrlf', 'false']);
  await commit(source, 'code.txt', original, 'Initial commit');
  await new Git(root).run(['init', '--bare', remote]);
  await upstream.run(['remote', 'add', 'origin', remote]);
  await upstream.run(['push', '-u', 'origin', 'main']);
  await new Git(root).run(['-c', 'core.autocrlf=false', 'clone', '-b', 'main', remote, client]);
  git = new Git(client);
  await git.run(['config', 'user.name', 'You']);
  await git.run(['config', 'user.email', 'you@example.test']);
  await git.run(['config', 'commit.gpgsign', 'false']);
  await git.run(['config', 'core.autocrlf', 'false']);
  await git.run(['checkout', '-b', 'feature']);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('local main maps to its tracked remote main', async () => {
  const plan = await defaultPlan();
  assert.equal(plan.target, 'origin/main');
  assert.equal(plan.trackingRef, 'refs/remotes/origin/main');
});

test('fetch and rebase preserve local feature commits, local main, and remote branches', async () => {
  await commit(client, 'feature.txt', 'feature work\n', 'Feature commit');
  const before = await head();
  const main = (await git.run(['rev-parse', 'main'])).trim();
  await pushMain();
  const result = await pullAndRebase(client, await defaultPlan());
  assert.equal(result.status, 'success');
  assert.notEqual(await head(), before);
  assert.equal((await git.run(['symbolic-ref', '--short', 'HEAD'])).trim(), 'feature');
  assert.equal((await git.run(['rev-parse', 'main'])).trim(), main);
  assert.equal((await git.run(['rev-parse', result.backupRef])).trim(), before);
  assert.equal((await git.run(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])), '');
  assert.equal(await fs.readFile(path.join(client, 'feature.txt'), 'utf8'), 'feature work\n');
  assert.equal(await fs.readFile(path.join(client, 'remote.txt'), 'utf8'), 'from teammate\n');
  assert.equal(await new Git(remote).exists('refs/heads/feature'), false);
  assert.equal(await git.exists('refs/stash'), false);
});

for (const state of ['unstaged', 'staged', 'untracked']) {
  test(`${state} changes block mutation without automatic stashing`, async () => {
    const file = state === 'untracked' ? 'new.txt' : 'code.txt';
    await fs.writeFile(path.join(client, file), 'unfinished work\n');
    if (state === 'staged') await git.run(['add', file]);
    const before = await head();
    const status = await git.run(['status', '--porcelain=v1', '-z']);
    await assert.rejects(pullAndRebase(client, await defaultPlan()), /Commit or stash/);
    assert.equal(await head(), before);
    assert.equal(await git.run(['status', '--porcelain=v1', '-z']), status);
    assert.equal(await git.exists('refs/stash'), false);
  });
}

test('detached HEAD and existing Git operations block sync', async () => {
  await git.run(['checkout', '--detach']);
  await assert.rejects(cleanBranch(git), /Detached HEAD/);
  await git.run(['checkout', 'feature']);
  await fs.writeFile(path.join(client, '.git', 'MERGE_HEAD'), await head());
  await assert.rejects(cleanBranch(git), /Finish the current Git operation/);
});

test('missing remote is actionable', async () => {
  await git.run(['remote', 'remove', 'origin']);
  await assert.rejects(defaultPlan(), /not configured/);
});

test('failed fetch leaves original HEAD and working tree unchanged', async () => {
  const before = await head();
  await git.run(['remote', 'set-url', 'origin', path.join(root, 'not-a-remote')]);
  await assert.rejects(pullAndRebase(client, await defaultPlan()));
  assert.equal(await head(), before);
  assert.equal(await git.run(['status', '--porcelain=v1', '-z']), '');
  assert.equal(await operationState(git), null);
});

test('same-line conflict pauses with continue and abort available', async () => {
  const result = await createConflict();
  assert.equal(result.status, 'paused');
  assert.equal((await operationState(git)).kind, 'rebase');
  assert.match(await git.run(['ls-files', '--unmerged']), /code.txt/);
  await assert.rejects(resumeRebase(client, 'continue'), /Resolve the conflicts and stage/);
});

test('abort restores the original feature branch and commit', async () => {
  const result = await createConflict();
  const aborted = await resumeRebase(client, 'abort');
  assert.equal(aborted.status, 'success');
  assert.equal(await head(), result.originalHead);
  assert.equal((await git.run(['symbolic-ref', '--short', 'HEAD'])).trim(), 'feature');
  assert.equal(await operationState(git), null);
  assert.equal(await git.run(['status', '--porcelain=v1', '-z']), '');
});

test('resolved and staged conflicts can continue without opening an editor', async () => {
  const result = await createConflict();
  await fs.writeFile(path.join(client, 'code.txt'), original.replace('base calculation', 'combined calculation'));
  await git.run(['add', 'code.txt']);
  const continued = await resumeRebase(client, 'continue');
  assert.equal(continued.status, 'success');
  assert.equal(await operationState(git), null);
  assert.notEqual(await head(), result.originalHead);
  assert.match(await fs.readFile(path.join(client, 'code.txt'), 'utf8'), /combined calculation/);
});

test('background fetch only updates tracking refs, ignoring custom local ref mappings', async () => {
  const before = await head();
  await git.run(['branch', 'protected', 'main']);
  const protectedSha = (await git.run(['rev-parse', 'protected'])).trim();
  await git.run(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/heads/protected']);
  await pushMain();
  await fetchRemote(client, 'origin');
  assert.equal(await head(), before);
  assert.equal((await git.run(['rev-parse', 'protected'])).trim(), protectedSha);
  assert.notEqual((await git.run(['rev-parse', 'origin/main'])).trim(), protectedSha);
  assert.equal((await inspect(client)).base, 'origin/main');
});

test('custom remote and remote tracking base are supported', async () => {
  await git.run(['remote', 'rename', 'origin', 'team']);
  const plan = await syncPlan(client, 'team/main', 'team');
  assert.equal(plan.remote, 'team');
  await pushMain();
  assert.equal((await pullAndRebase(client, plan)).status, 'success');
});

test('branch switches during fetch prevent rebase', async () => {
  await git.run(['branch', 'other']);
  const originalRun = Git.prototype.run;
  Git.prototype.run = async function (args, ...rest) {
    const result = await originalRun.call(this, args, ...rest);
    if (args[0] === 'fetch' && this.repo === path.resolve(client)) await originalRun.call(this, ['checkout', 'other']);
    return result;
  };
  try {
    await assert.rejects(pullAndRebase(client, await defaultPlan()), /branch changed during the fetch/);
    assert.equal((await git.run(['symbolic-ref', '--short', 'HEAD'])).trim(), 'other');
    assert.equal(await operationState(git), null);
  } finally { Git.prototype.run = originalRun; }
});

test('worktree rebase markers are detected in that worktree', async () => {
  const worktree = path.join(root, 'linked-worktree');
  await git.run(['worktree', 'add', '-b', 'linked', worktree, 'main']);
  const linked = new Git(worktree);
  const marker = (await linked.run(['rev-parse', '--git-path', 'rebase-merge'])).trim();
  await fs.mkdir(path.resolve(worktree, marker));
  assert.equal((await operationState(linked)).kind, 'rebase');
  assert.equal(await operationState(git), null);
});
