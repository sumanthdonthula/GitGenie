'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const runtime = { trusted: true, polls: 0, calls: [], events: [], implementation: null };
const sha = 'a'.repeat(40);
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'vscode') return {
    workspace: {
      get isTrusted() { return runtime.trusted; },
      openTextDocument: async options => options,
    },
    window: { showInformationMessage: async () => undefined, showTextDocument: async () => {} },
    ConfigurationTarget: { Global: 1 },
  };
  if (name === './advisor') return {
    PushWatcher: class { async poll() { runtime.polls++; return runtime.events.splice(0); } },
    review: async (...params) => {
      runtime.calls.push(params);
      if (runtime.implementation) return runtime.implementation(...params);
      return { sha: params[1].sha, ref: params[1].ref, text: 'Advisory', sources: [], limitations: [] };
    },
  };
  if (name === './git') return { Git: class { async run() { return sha; } } };
  return originalLoad.call(this, name, ...args);
};
const { Advisor } = require('../src/advisor-controller');
Module._load = originalLoad;

function fixture(settings = {}) {
  Object.assign(runtime, { trusted: true, polls: 0, calls: [], events: [], implementation: null });
  const config = { get: (key, fallback) => key in settings ? settings[key] : fallback,
    update: async (key, value) => { settings[key] = value; } };
  const companion = { repo: '/repo', state: { mode: 'watching' }, config: () => config,
    send() {}, output: { appendLine() {} } };
  return { advisor: new Advisor(companion), companion, settings };
}
async function settle(advisor) {
  for (let i = 0; i < 50 && advisor.state.busy; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(advisor.state.busy, false);
}

test('disabled or untrusted workspaces never collect content or invoke Claude', async () => {
  const { advisor, settings } = fixture();
  await advisor.poll(); await advisor.request();
  assert.equal(runtime.polls, 0); assert.equal(runtime.calls.length, 0);
  settings['claude.enabled'] = true; runtime.trusted = false;
  await advisor.poll(); await advisor.request();
  assert.equal(runtime.polls, 0); assert.equal(runtime.calls.length, 0);
  advisor.dispose();
});

test('push reviews are serialized and retain each pushed SHA', async () => {
  const { advisor } = fixture({ 'claude.enabled': true });
  let release;
  runtime.implementation = async (repo, event) => {
    if (event.sha === sha) await new Promise(resolve => { release = resolve; });
    return { sha: event.sha, ref: event.ref, text: 'Review', sources: [], limitations: [] };
  };
  runtime.events = [{ ref: 'origin/main', sha }, { ref: 'origin/main', sha: 'b'.repeat(40) }];
  await advisor.poll();
  assert.equal(runtime.calls.length, 1);
  await advisor.poll();
  assert.equal(runtime.calls.length, 1, 'No second Claude process while the first is running');
  release(); await settle(advisor);
  assert.equal(runtime.calls.length, 2);
  assert.equal(advisor.state.report.sha, 'b'.repeat(40));
  advisor.dispose();
});

test('switching repositories aborts an active review and suppresses its stale result', async () => {
  const { advisor, companion } = fixture({ 'claude.enabled': true });
  let release;
  runtime.implementation = async () => new Promise(resolve => { release = resolve; });
  runtime.events = [{ ref: 'origin/main', sha }];
  await advisor.poll();
  const signal = runtime.calls[0][2].signal;
  companion.repo = '/other';
  await advisor.poll();
  assert.equal(signal.aborted, true);
  release({ sha, text: 'OLD RESULT', sources: [], limitations: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(advisor.state.report, null);
  assert.equal(advisor.state.busy, false);
  advisor.dispose();
});

test('manual review works with on-push disabled, demo is inert, and errors allow retry', async () => {
  const { advisor, companion } = fixture({ 'claude.enabled': true, 'claude.onPush': false });
  runtime.events = [{ ref: 'origin/main', sha }];
  await advisor.poll(); assert.equal(runtime.calls.length, 0);
  companion.state.mode = 'demo';
  await advisor.request(); assert.equal(runtime.calls.length, 0);
  companion.state.mode = 'watching';
  runtime.implementation = async () => { throw new Error('Sign in to Claude'); };
  await advisor.request();
  assert.match(advisor.state.message, /Sign in/);
  assert.equal(advisor.state.busy, false);
  runtime.implementation = null;
  await advisor.request();
  assert.equal(advisor.state.report.sha, sha);
  advisor.dispose();
});

test('delayed duplicate configuration events do not cancel a newly enabled manual review', async () => {
  const { advisor } = fixture();
  await advisor.enable();
  let release;
  runtime.implementation = async () => new Promise(resolve => { release = resolve; });
  const pending = advisor.request();
  await new Promise(resolve => setImmediate(resolve));
  const signal = runtime.calls[0][2].signal;
  advisor.configure();
  assert.equal(signal.aborted, false);
  release({ sha, text: 'Review', sources: [], limitations: [] });
  await pending;
  assert.equal(advisor.state.report.sha, sha);
  advisor.dispose();
});
