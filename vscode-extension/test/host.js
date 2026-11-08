'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Git } = require('../src/git');

async function until(check, label) {
  const end = Date.now() + 30000;
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
  console.log('Extension host passed: automatic fetch, real analysis, Pull & Rebase conflict, abort, resolved continuation, summon, and demo.');
}

module.exports = { run };
