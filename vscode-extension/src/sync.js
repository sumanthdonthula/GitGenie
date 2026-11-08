'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Git } = require('./git');

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function operationState(git) {
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
    const location = (await git.run(['rev-parse', '--git-path', marker])).trim();
    if (await exists(path.resolve(git.repo, location))) {
      return { kind: marker.startsWith('rebase-') ? 'rebase' : 'other', marker };
    }
  }
  return null;
}

async function syncPlan(repo, requestedBase = '', preferredRemote = 'origin') {
  const git = new Git(repo);
  const remotes = (await git.run(['remote'])).trim().split(/\r?\n/).filter(Boolean);
  let base = requestedBase;
  if (!base) {
    for (const name of [`${preferredRemote}/main`, `${preferredRemote}/master`, 'main', 'master']) {
      if (await git.exists(name)) { base = name; break; }
    }
  }
  if (!base || base.startsWith('-')) throw new Error('Choose a comparison branch before pulling and rebasing.');
  let remote, remoteBranch;
  const tracking = base.replace(/^refs\/remotes\//, '');
  // Longest prefix handles remote names containing slashes.
  remote = [...remotes].sort((a, b) => b.length - a.length).find(name => tracking.startsWith(`${name}/`));
  if (remote) remoteBranch = tracking.slice(remote.length + 1);
  else {
    const local = base.replace(/^refs\/heads\//, '');
    const upstream = (await git.run(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${local}`])).trim().split('\0');
    if (upstream[0] && upstream[0] !== '.' && upstream[1]?.startsWith('refs/heads/')) {
      remote = upstream[0]; remoteBranch = upstream[1].slice('refs/heads/'.length);
    } else { remote = preferredRemote; remoteBranch = local; }
  }
  if (!remotes.includes(remote)) throw new Error(`Remote “${remote}” is not configured. Add a remote or choose one in Git Genie settings.`);
  if (!remoteBranch || remoteBranch === 'HEAD') throw new Error('Choose a named comparison branch, such as origin/main.');
  await git.run(['check-ref-format', `refs/heads/${remoteBranch}`]);
  const trackingRef = `refs/remotes/${remote}/${remoteBranch}`;
  await git.run(['check-ref-format', trackingRef]);
  return { remote, remoteBranch, trackingRef, target: `${remote}/${remoteBranch}` };
}

async function cleanBranch(git) {
  const branch = (await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim();
  if (!branch) throw new Error('Check out a branch before pulling and rebasing. Detached HEAD is not supported for this action.');
  if (!await git.exists('HEAD')) throw new Error('Make your first commit before pulling and rebasing.');
  const active = await operationState(git);
  if (active) throw new Error(active.kind === 'rebase' ? 'A rebase is already paused. Continue or abort it before syncing again.' : 'Finish the current Git operation before pulling and rebasing.');
  const dirty = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (dirty) throw new Error('Commit or stash your staged, unstaged, and untracked changes before pulling and rebasing.');
  return { branch, head: (await git.run(['rev-parse', 'HEAD'])).trim() };
}

async function fetchRemote(repo, remote = 'origin') {
  const git = new Git(repo);
  const remotes = (await git.run(['remote'])).trim().split(/\r?\n/);
  if (!remotes.includes(remote)) throw new Error(`Remote “${remote}” is not configured.`);
  await git.run(['check-ref-format', `refs/remotes/${remote}/main`]);
  await git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--refmap=', '--', remote,
    `+refs/heads/*:refs/remotes/${remote}/*`], [0], { timeout: 90000 });
}

async function pullAndRebase(repo, plan, progress = () => {}) {
  const git = new Git(repo);
  // Recompute instead of trusting a stale webview or caller-supplied refspec.
  const verified = await syncPlan(repo, plan.target, plan.remote);
  const before = await cleanBranch(git);
  progress(`Fetching ${verified.target}…`);
  await git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--refmap=', '--', verified.remote,
    `+refs/heads/${verified.remoteBranch}:${verified.trackingRef}`], [0], { timeout: 90000 });
  const after = await cleanBranch(git);
  if (after.branch !== before.branch || after.head !== before.head) throw new Error('Your branch changed during the fetch. Nothing was rebased; review the branch and try again.');
  const targetSha = (await git.run(['rev-parse', '--verify', `${verified.trackingRef}^{commit}`])).trim();
  await git.run(['merge-base', before.head, targetSha]);
  const backupRef = `refs/gitgenie/backups/${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await git.run(['update-ref', backupRef, before.head, '0'.repeat(before.head.length)]);
  progress(`Rebasing ${before.branch} onto ${verified.target}…`);
  try {
    const output = await git.run(['rebase', '--rebase-merges', '--no-autostash', '--no-update-refs', '--', targetSha], [0], { timeout: 120000 });
    return { status: 'success', target: verified.target, branch: before.branch, backupRef, originalHead: before.head, output };
  } catch (error) {
    if ((await operationState(git))?.kind === 'rebase') {
      return { status: 'paused', target: verified.target, branch: before.branch, backupRef, originalHead: before.head, output: error.output || error.message };
    }
    throw new Error(`${error.message}\nOriginal commit saved at ${backupRef}.`);
  }
}

async function resumeRebase(repo, action) {
  if (!['continue', 'abort'].includes(action)) throw new Error('Unknown rebase action.');
  const git = new Git(repo);
  if ((await operationState(git))?.kind !== 'rebase') throw new Error('There is no paused rebase in this repository.');
  if (action === 'continue' && (await git.run(['ls-files', '--unmerged', '-z']))) {
    throw new Error('Resolve the conflicts and stage the resolved files in Source Control, then continue the rebase.');
  }
  try {
    const output = await git.run(['rebase', `--${action}`], [0], { timeout: 120000, env: { GIT_EDITOR: 'true' } });
    return { status: 'success', action, output };
  } catch (error) {
    if ((await operationState(git))?.kind === 'rebase') return { status: 'paused', action, output: error.output || error.message };
    throw error;
  }
}

module.exports = { syncPlan, cleanBranch, pullAndRebase, resumeRebase, operationState, fetchRemote };
