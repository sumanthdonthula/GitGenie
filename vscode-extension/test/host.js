'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Git } = require('../src/git');

async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const extension = vscode.extensions.getExtension('gitgenie-local.git-genie');
  assert.ok(extension, 'Extension must be registered');
  const api = await extension.activate();
  await vscode.commands.executeCommand('gitgenie.refresh');
  let state;
  try {
    state = await until(() => {
      const state = api.getState();
      return state.mode === 'watching' && state;
    }, 'real workspace analysis');
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(api.getState())}`);
  }
  assert.equal(state.snapshot.branch, 'feature/free-shipping');
  assert.equal(state.snapshot.latest.subject, 'Add free shipping over $50');
  assert.deepEqual(state.snapshot.overlaps[0].authors, ['dev-2']);
  assert.equal(state.sync.target, 'origin/main');
  assert.equal(state.fetchInfo.enabled, true);
  const firstFetch = state.fetchInfo.lastFetch;
  assert.ok(firstFetch, 'Startup fetch must complete');
  await until(() => api.getState().fetchInfo.lastFetch !== firstFetch,
    'a second automatic fetch on the 30-second cadence', 45000);
  console.log('30-second background fetch verified against a real local remote.');
  const repo = state.snapshot.root;
  const git = new Git(repo);
  const originalHead = (await git.run(['rev-parse', 'HEAD'])).trim();
  await vscode.commands.executeCommand('gitgenie.pullAndRebase');
  assert.equal(api.getState().sync.paused, true, api.getState().sync.message);
  assert.match(api.getState().sync.message, /Rebase paused/);
  await vscode.commands.executeCommand('gitgenie.abortRebase');
  assert.equal(api.getState().sync.paused, false);
  assert.equal((await git.run(['rev-parse', 'HEAD'])).trim(), originalHead);
  await vscode.commands.executeCommand('gitgenie.pullAndRebase');
  assert.equal(api.getState().sync.paused, true, api.getState().sync.message);
  await fs.writeFile(path.join(repo, 'checkout.ts'), 'export function shippingTotal(subtotal: number) {\n  return subtotal > 50 ? subtotal : subtotal + 8;\n}\n');
  await git.run(['add', 'checkout.ts']);
  await vscode.commands.executeCommand('gitgenie.continueRebase');
  assert.equal(api.getState().sync.paused, false, api.getState().sync.message);
  assert.match(api.getState().sync.message, /completed/);
  assert.notEqual((await git.run(['rev-parse', 'HEAD'])).trim(), originalHead);
  await vscode.commands.executeCommand('gitgenie.summon');
  await vscode.commands.executeCommand('gitgenie.demo');
  assert.equal(api.getState().mode, 'demo');
  await vscode.commands.executeCommand('gitgenie.refresh');
  await until(() => api.getState().mode === 'watching', 'return from demo');
  assert.equal(api.getState().advisor.enabled, false, 'Claude must be opt-in');
  const fakeClaude = path.join(path.dirname(repo), 'fake-claude.js');
  await fs.writeFile(fakeClaude, `let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
    const context=JSON.parse(input);
    const sources=context.docs.map(d=>d.path).join(', ');
    process.stdout.write(JSON.stringify({type:'result',result:'Review of '+context.sha+'; sources: '+sources}));
  });`);
  const config = vscode.workspace.getConfiguration('gitgenie');
  await config.update('claude.command', fakeClaude, vscode.ConfigurationTarget.Global);
  await fs.mkdir(path.join(repo, 'docs', 'git'), { recursive: true });
  await fs.writeFile(path.join(repo, 'docs', 'git', 'commits.md'), 'Use concise imperative subjects.');
  await git.run(['add', 'docs/git/commits.md']);
  await git.run(['commit', '-m', 'docs: add commit guidelines']);
  await vscode.commands.executeCommand('gitgenie.enableClaude');
  await vscode.commands.executeCommand('gitgenie.reviewWithClaude');
  assert.ok(api.getState().advisor.report, JSON.stringify(api.getState().advisor));
  assert.match(api.getState().advisor.report.text, /docs\/git\/commits.md/);
  const beforePush = api.getState().advisor.report.sha;
  await fs.writeFile(path.join(repo, 'follow-up.txt'), 'A focused follow-up change.');
  await git.run(['add', 'follow-up.txt']); await git.run(['commit', '-m', 'feat: follow up']);
  const pushed = (await git.run(['rev-parse', 'HEAD'])).trim();
  assert.notEqual(pushed, beforePush);
  await git.run(['push', '-u', 'origin', 'HEAD']);
  await until(() => api.getState().advisor.report?.sha === pushed, 'automatic Claude review of real push', 40000);
  assert.match(api.getState().advisor.report.ref, /refs\/remotes\/origin/);
  await vscode.commands.executeCommand('gitgenie.showClaudeSuggestions');
  assert.match(vscode.window.activeTextEditor.document.getText(), /CLAUDE SUGGESTIONS/);
  await config.update('claude.enabled', false, vscode.ConfigurationTarget.Global);
  console.log('Extension host passed: Git sync/recovery, opt-in Claude manual and automatic push reviews, committed guidelines, and report view. Claude was simulated; no paid calls made.');
}

module.exports = { run };
