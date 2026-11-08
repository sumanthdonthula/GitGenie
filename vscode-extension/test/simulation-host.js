'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const vscode = require('vscode');
const { Git } = require('../src/git');

async function until(api, predicate, label) {
  const started = Date.now();
  while (Date.now() - started < 35000) {
    const state = api.getState();
    if (state.mode === 'watching' && predicate(state.snapshot)) return state.snapshot;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}. Last state: ${JSON.stringify(api.getState())}`);
}

function runCommand(executable, args, cwd, accepted = [0]) {
  return new Promise((resolve, reject) => execFile(executable, args, { cwd, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
    const code = error?.code || 0;
    if (accepted.includes(code)) resolve({ code, stdout, stderr });
    else reject(new Error(`${stderr || stdout || error.message}`));
  }));
}

async function run() {
  const repo = process.env.GENIE_SIMULATION_REPO;
  const teammate = process.env.GENIE_SIMULATION_TEAMMATE;
  assert.ok(repo && teammate, 'Run this through scripts/Run-Real-Git-Simulation.js');
  const manifestFile = process.env.GENIE_SIMULATION_MANIFEST;
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const extension = vscode.extensions.getExtension('gitgenie-local.git-genie');
  assert.ok(extension, 'Installed extension must be loaded');
  assert.equal(path.resolve(extension.extensionPath).toLowerCase(), path.resolve(manifest.installedExtension).toLowerCase());
  const api = await extension.activate();
  const git = new Git(repo), dev2 = new Git(teammate);
  const featureHead = (await git.run(['rev-parse', 'HEAD'])).trim();
  const results = [];
  const record = (name, snapshot, extra = {}) => {
    results.push({ name, passed: true, observedAt: new Date().toISOString(), snapshot, ...extra });
    console.log(`PASS: ${name}`);
  };

  let state = await until(api, s => s.branch === 'feature/free-shipping' && s.behind === 0, 'clean feature branch');
  assert.equal(state.overlaps.length, 0);
  assert.equal(state.demo, undefined);
  record('Feature branch ahead of main: no false overlap alert', state);

  await fs.appendFile(path.join(teammate, 'README.md'), '\nDev-2 clarified the shipping policy documentation.\n');
  await dev2.run(['-c', 'user.name=dev-2', '-c', 'user.email=dev2@example.test', 'commit', '-am', 'Clarify shipping policy documentation']);
  const docsCommit = (await dev2.run(['rev-parse', 'HEAD'])).trim();
  state = await until(api, s => s.incoming.some(c => c.sha === docsCommit), 'automatic discovery of independent main commit');
  assert.equal(state.overlaps.length, 0);
  assert.equal(state.behind, 1);
  record('Dev-2 edits a different file: newer main commit, no overlap', state, { refresh: 'automatic polling; no manual refresh command' });

  const source = path.join(teammate, 'src', 'shipping.js');
  await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('return subtotal + 5;', 'return subtotal + 8;'));
  await dev2.run(['-c', 'user.name=dev-2', '-c', 'user.email=dev2@example.test', 'commit', '-am', 'Raise standard shipping fee from $5 to $8']);
  const feeCommit = (await dev2.run(['rev-parse', 'HEAD'])).trim();
  state = await until(api, s => s.incoming.some(c => c.sha === feeCommit) && s.overlaps.length > 0, 'automatic same-line warning');
  assert.equal(state.overlaps[0].path, 'src/shipping.js');
  assert.equal(state.overlaps[0].kind, 'same lines');
  assert.deepEqual(state.overlaps[0].authors, ['dev-2']);
  record('Dev-2 edits the same line: correct file, same-line risk, and author', state, { refresh: 'automatic polling; no manual refresh command' });

  const merge = await runCommand('git', ['merge-tree', '--write-tree', 'main', 'HEAD'], repo, [0, 1]);
  assert.equal(merge.code, 1, 'Git itself must confirm this case conflicts');
  record('Git merge-tree independently confirms a real content conflict', state, { mergeExitCode: merge.code, mergeOutput: merge.stdout });

  const localFile = path.join(repo, 'src', 'shipping.js');
  await fs.appendFile(localFile, '\n// TODO: reconcile free shipping with dev-2\'s new standard fee before rebasing.\n');
  await git.run(['add', 'src/shipping.js']);
  state = await until(api, s => s.dirtyFiles === 1 && s.overlaps.some(o => o.path === 'src/shipping.js'), 'staged local edit');
  record('Staged local changes are included while the overlap remains', state, { refresh: 'automatic polling; no manual refresh command' });

  const before = await git.run(['status', '--porcelain=v1', '-z']);
  await vscode.commands.executeCommand('gitgenie.refresh');
  await until(api, s => s.dirtyFiles === 1, 'final analysis');
  assert.equal((await git.run(['rev-parse', 'HEAD'])).trim(), featureHead);
  assert.equal(await git.run(['symbolic-ref', '--short', 'HEAD']), 'feature/free-shipping\n');
  assert.equal(await git.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal((await git.run(['ls-files', '--unmerged'])).trim(), '');
  assert.equal((await git.run(['remote'])).trim(), '');
  record('Genie leaves branch, HEAD, staged edits, and merge state unchanged; no remote', state);

  const appTests = await runCommand('node', ['--test', path.join(repo, 'test', 'shipping.test.js')], repo);
  record('The simulated application passes all four shipping tests', state, { output: appTests.stdout });

  const report = { ...manifest, completedAt: new Date().toISOString(), passed: true, tests: results };
  const artifactDir = path.dirname(manifestFile);
  await fs.writeFile(path.join(artifactDir, 'real-git-simulation-results.json'), JSON.stringify(report, null, 2));
  const markdown = [
    '# Real Git simulation results', '', `Installed extension: Git Genie ${manifest.extensionVersion}`, '',
    `Project: ${repo}`, `Dev-2 worktree: ${teammate}`, '',
    ...results.map(item => `- PASS: ${item.name}`), '',
    'The branch was checked automatically after each teammate commit; no manual refresh was used for those checks.',
    'The final project remains on feature/free-shipping with one staged TODO comment. No remote is configured.', '',
    '## Git history', '```', (await git.run(['log', '--all', '--graph', '--oneline', '--decorate'])).trim(), '```', '',
    '## Independent Git merge check', '```', merge.stdout.trim(), '```', '',
    'The merge-tree check writes temporary Git objects but does not alter the working tree or index.',
    'Git documentation: https://git-scm.com/docs/git-merge-tree.html', '',
    '## Try it', '', 'Open the project in VS Code and click the Git Genie lamp. The same-line warning should appear.',
    'Run `git diff --cached` to inspect the staged local comment or `git log --all --graph --oneline` to inspect the simulated history.',
  ].join('\n');
  await fs.writeFile(path.join(artifactDir, 'real-git-simulation-results.md'), markdown);
  await vscode.commands.executeCommand('gitgenie.summon');
  console.log(`Simulation complete: ${results.length} scenarios passed. Report: ${path.join(artifactDir, 'real-git-simulation-results.md')}`);
}

module.exports = { run };
