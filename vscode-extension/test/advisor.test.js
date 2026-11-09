'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Git } = require('../src/git');
const { PushWatcher, collectContext, review, runClaude, resolveClaude, fetchReference } = require('../src/advisor');

let folder, repo, git, remote;
async function write(name, text) {
  const file = path.join(repo, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
async function commit(subject = 'feat: initial') {
  await git.run(['add', '--all']);
  await git.run(['commit', '-m', subject]);
  return (await git.run(['rev-parse', 'HEAD'])).trim();
}
beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-advisor-test-'));
  repo = path.join(folder, 'work'); remote = path.join(folder, 'remote.git');
  await fs.mkdir(repo);
  git = new Git(repo);
  await git.run(['init', '-b', 'main']);
  await git.run(['config', 'user.name', 'Test']);
  await git.run(['config', 'user.email', 'test@example.test']);
  await git.run(['init', '--bare', remote]);
  await git.run(['remote', 'add', 'origin', remote]);
  await write('app.js', 'const fee = 5;\n');
  await commit();
});
afterEach(async () => {
  assert.ok(folder.startsWith(path.join(os.tmpdir(), 'genie-advisor-test-')));
  await fs.rm(folder, { recursive: true, force: true });
});

test('pushes from CLI are detected once, historical pushes and fetches are ignored', async () => {
  await git.run(['push', '-u', 'origin', 'main']);
  const watcher = new PushWatcher();
  assert.deepEqual(await watcher.poll(repo), []);
  await write('app.js', 'const fee = 8;\n');
  const before = (await git.run(['rev-parse', 'HEAD'])).trim();
  const sha = await commit('fix: raise fee');
  await git.run(['push']);
  const events = await watcher.poll(repo);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { ref: 'refs/remotes/origin/main', sha, before });
  assert.deepEqual(await watcher.poll(repo), []);
  await git.run(['fetch', 'origin']);
  assert.deepEqual(await watcher.poll(repo), []);
  await git.run(['push']); // Successful no-op pushes do not write a reflog entry.
  assert.deepEqual(await watcher.poll(repo), []);
  const other = path.join(folder, 'other');
  await git.run(['clone', remote, other]);
  const second = new Git(other);
  await second.run(['checkout', 'main']);
  await second.run(['config', 'user.name', 'Peer']);
  await second.run(['config', 'user.email', 'peer@example.test']);
  await fs.writeFile(path.join(other, 'peer.txt'), 'hello');
  await second.run(['add', '.']); await second.run(['commit', '-m', 'docs: peer']); await second.run(['push']);
  await git.run(['fetch', 'origin']);
  assert.deepEqual(await watcher.poll(repo), [], 'A remote teammate push seen through fetch is not our push');
});

test('new branches and multiple pushes between checks are retained in order', async () => {
  const watcher = new PushWatcher();
  await watcher.poll(repo);
  await git.run(['push', '-u', 'origin', 'main']);
  const first = (await git.run(['rev-parse', 'HEAD'])).trim();
  await write('app.js', 'const fee = 9;\n'); const second = await commit('fix: fee');
  await git.run(['push']);
  const events = await watcher.poll(repo);
  assert.deepEqual(events.map(event => event.sha), [first, second]);
  assert.equal(events[1].before, first);
  assert.deepEqual(await watcher.poll(repo), []);
});

test('force pushes use merge base; changed worktree and symlink docs are excluded', async () => {
  await write('docs/git/commits.md', 'Use imperative messages.');
  await write('CONTRIBUTING.md', 'Add a regression test for bug fixes.');
  const before = await commit('docs: guidelines');
  await write('app.js', 'const fee = 8;\n');
  const oldTip = await commit('feat: old feature');
  await git.run(['reset', '--hard', before]);
  await write('app.js', 'const fee = 10;\n');
  const sha = await commit('fix: new feature');
  // Install a symlink blob without requiring Windows symlink privileges.
  const target = path.join(folder, 'secret.txt'); await fs.writeFile(target, 'NEVER INCLUDE');
  await write('target.txt', target);
  const oid = (await git.run(['hash-object', '-w', 'target.txt'])).trim();
  await git.run(['update-index', '--add', '--cacheinfo', `120000,${oid},docs/git/linked.md`]);
  await git.run(['commit', '-m', 'docs: symlink']);
  const withLink = (await git.run(['rev-parse', 'HEAD'])).trim();
  await write('docs/git/commits.md', 'UNCOMMITTED SECRET');
  await write('docs/git/untracked.md', 'UNTRACKED SECRET');
  await write('app.js', 'WORKTREE SECRET');
  const status = await git.run(['status', '--porcelain=v1', '-z']);
  const context = await collectContext(repo, { sha: withLink, before: oldTip });
  assert.equal(context.base, before);
  assert.ok(context.commits.includes(sha));
  assert.equal(context.docs.length, 2);
  assert.match(context.docs.find(doc => doc.path === 'docs/git/commits.md').content, /imperative/);
  assert.doesNotMatch(JSON.stringify(context), /UNCOMMITTED SECRET|UNTRACKED SECRET|WORKTREE SECRET|NEVER INCLUDE/);
  assert.equal(await git.run(['status', '--porcelain=v1', '-z']), status);
  assert.equal((await git.run(['rev-parse', 'HEAD'])).trim(), withLink);
});

test('manual/root review, source limits, and untrusted paths', async () => {
  await write('docs/git/large.md', 'a'.repeat(20000));
  const sha = await commit('docs: large guideline');
  const context = await collectContext(repo, { sha });
  assert.match(context.docs[0].content, /\[TRUNCATED\]/);
  assert.ok(context.docs[0].content.length < 12100);
  assert.match(context.limitations.join(' '), /latest commit/);
  await assert.rejects(collectContext(repo, { sha: '--exec=bad' }), /Invalid review commit/);
  await assert.rejects(collectContext(repo, { sha }, ['../secret']), /repository-relative/);
});

test('review includes explicit sources and handles unavailable reference docs without losing local review', async () => {
  await write('docs/git/style.md', 'Use concise subjects.');
  const sha = await commit('docs: style');
  let received;
  const result = await review(repo, { sha }, { referenceUrls: ['https://example.test/git'] }, {
    fetchReference: async () => { throw new Error('offline'); },
    runClaude: async prompt => { received = JSON.parse(prompt); return 'Summary: one suggestion.'; },
  });
  assert.deepEqual(result.sources, ['docs/git/style.md']);
  assert.match(received.limitations.join(' '), /offline/);
  assert.equal(result.sha, sha);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(review(repo, { sha }, { signal: controller.signal }), /cancelled/);
  assert.throws(() => fetchReference('http://example.test'), /HTTPS/);
});

test('Claude launches with no shell or tools and receives context only on stdin', async () => {
  const cli = path.join(folder, 'fake cli.js');
  await fs.writeFile(cli, `let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({type:'result', result:JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), input})}));
  });`);
  const context = '$(not-a-command) \u0060not-a-command\u0060 <script>nope</script>';
  const result = JSON.parse(await runClaude(context, { command: cli }));
  assert.equal(result.input, context);
  assert.ok(result.args.includes('--safe-mode'));
  assert.equal(result.args[result.args.indexOf('--tools') + 1], '');
  assert.equal(result.args[result.args.indexOf('--disallowedTools') + 1], '*');
  assert.ok(result.args.includes('--no-session-persistence'));
  assert.equal(result.args.includes(context), false);
  assert.notEqual(result.cwd, repo);
  await assert.rejects(fs.stat(result.cwd), /ENOENT/, 'Temporary invocation directory must be removed');
  await assert.rejects(resolveClaude(path.join(folder, 'missing.exe')), /not found/);
});

test('Claude auth failures, malformed responses, timeout and cancellation remain actionable', async () => {
  const cli = path.join(folder, 'fake.js');
  await fs.writeFile(cli, `process.stdout.write(JSON.stringify({type:'result',is_error:true,result:'not signed in'}));`);
  await assert.rejects(runClaude('context', { command: cli }), /auth status/);
  await fs.writeFile(cli, `process.stdout.write('not json');`);
  await assert.rejects(runClaude('context', { command: cli }), /invalid JSON/);
  await fs.writeFile(cli, `setTimeout(()=>{}, 10000);`);
  await assert.rejects(runClaude('context', { command: cli, timeout: 100 }), /timed out/);
  const controller = new AbortController();
  const pending = runClaude('context', { command: cli, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /cancelled/);
});

test('HTTPS references strip executable markup, cache success, and reject redirects and oversized bodies', async () => {
  const originalGet = https.get;
  let requests = 0, responseCode = 200, contentType = 'text/html', body = '<script>BAD_SCRIPT</script><h1>Git guidance</h1><p>Use clear messages.</p>';
  https.get = (url, options, callback) => {
    requests++;
    assert.equal(options.timeout, 10000);
    const request = new EventEmitter();
    request.destroy = error => { request.emit('error', error); request.emit('close'); };
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = responseCode;
      response.headers = { 'content-type': contentType };
      callback(response);
      response.end(body);
      response.on('close', () => request.emit('close'));
    });
    return request;
  };
  try {
    const doc = await fetchReference('https://example.test/policy');
    assert.match(doc.content, /Git guidance/);
    assert.doesNotMatch(doc.content, /BAD_SCRIPT|<h1>/);
    assert.deepEqual(await fetchReference('https://example.test/policy'), doc);
    assert.equal(requests, 1);
    responseCode = 302;
    await assert.rejects(fetchReference('https://example.test/redirect'), /redirects are not followed/);
    responseCode = 200; contentType = 'application/octet-stream';
    await assert.rejects(fetchReference('https://example.test/binary'), /not a text document/);
    contentType = 'text/plain'; body = 'a'.repeat(512001);
    await assert.rejects(fetchReference('https://example.test/large'), /exceeds 512 KB/);
  } finally { https.get = originalGet; }
});
