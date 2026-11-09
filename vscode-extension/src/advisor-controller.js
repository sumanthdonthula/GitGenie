'use strict';

const vscode = require('vscode');
const { Git } = require('./git');
const { PushWatcher, review } = require('./advisor');

class Advisor {
  constructor(companion) {
    this.companion = companion;
    this.watcher = new PushWatcher();
    this.state = { enabled: false, busy: false, message: 'Enable Claude reviews to get Git and commit suggestions after pushes.', report: null };
    this.queue = [];
    this.epoch = 0;
    this.failed = false;
  }

  publish() { this.companion.send(); }

  configure() {
    const config = this.companion.config();
    const key = JSON.stringify(['enabled', 'onPush', 'command', 'docFolders', 'referenceUrls', 'timeoutSeconds']
      .map(name => config.get(`claude.${name}`)));
    if (key !== this.configuration) {
      this.configuration = key;
      this.reset();
    }
  }

  reset() {
    this.epoch++;
    this.abort?.abort();
    this.queue = [];
    this.watcher = new PushWatcher();
    this.repo = null;
    this.failed = false;
    this.state = { enabled: false, busy: false, message: 'Claude reviews are off.', report: null };
    this.publish();
  }

  async poll() {
    if (this.polling || this.disposed) return;
    this.polling = true;
    let epoch = this.epoch;
    try {
      const companion = this.companion;
      if (companion.state.mode === 'demo') return;
      this.configure();
      epoch = this.epoch;
      const config = companion.config();
      const enabled = vscode.workspace.isTrusted && config.get('claude.enabled', false);
      const repo = companion.repo;
      if (repo !== this.repo) {
        this.reset();
        this.repo = repo;
        epoch = this.epoch;
      }
      this.state.enabled = enabled;
      if (!enabled || !repo) {
        this.watcher = new PushWatcher();
        this.state.message = enabled ? 'Choose a repository for Claude reviews.' : 'Enable Claude reviews to send committed changes and guidelines to your signed-in Claude CLI.';
        this.publish(); return;
      }
      const events = await this.watcher.poll(repo);
      if (epoch !== this.epoch || this.disposed) return;
      if (config.get('claude.onPush', true)) {
        for (const event of events) this.queue.push({ repo, event });
      }
      if (!this.failed && !this.state.busy && !this.queue.length && !this.state.report) this.state.message = 'Watching for pushes · Review with Claude is also available now.';
      this.publish();
      void this.drain();
    } catch (error) {
      if (epoch === this.epoch && !this.disposed) {
        this.state.message = `Claude push monitoring: ${error.message}`;
        this.publish();
      }
    } finally { this.polling = false; }
  }

  async enable() {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showInformationMessage('Trust this workspace before enabling Claude reviews.'); return;
    }
    await this.companion.config().update('claude.enabled', true, vscode.ConfigurationTarget.Global);
    this.configure();
    await this.poll();
    await this.poll();
  }

  async request() {
    this.configure();
    if (!vscode.workspace.isTrusted || !this.companion.config().get('claude.enabled', false)) {
      void vscode.window.showInformationMessage('Enable Git Genie Claude reviews in Settings first. Selected committed diffs and guidelines are sent through your signed-in Claude CLI.'); return;
    }
    if (!this.companion.repo || this.companion.state.mode === 'demo' || this.state.busy) return;
    const repo = this.companion.repo;
    if (repo !== this.repo) { this.reset(); this.repo = repo; }
    const epoch = this.epoch;
    try {
      const sha = (await new Git(repo).run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      if (epoch !== this.epoch || this.disposed) return;
      this.queue.push({ repo, event: { sha, before: null, ref: 'Manual review of HEAD' } });
      await this.drain();
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      this.state.message = error.message; this.publish();
    }
  }

  async drain() {
    if (this.state.busy || this.disposed) return;
    const epoch = this.epoch;
    while (this.queue.length && epoch === this.epoch && !this.disposed) {
      const { repo, event } = this.queue.shift();
      if (!vscode.workspace.isTrusted || !this.companion.config().get('claude.enabled', false) || this.companion.repo !== repo) return;
      this.abort = new AbortController();
      this.failed = false;
      this.state.busy = true;
      this.state.report = null;
      this.state.message = `Reviewing ${event.ref} at ${event.sha.slice(0, 7)} with Claude…`;
      this.publish();
      const config = this.companion.config();
      try {
        const report = await review(repo, event, {
          command: config.get('claude.command', 'claude'),
          docFolders: config.get('claude.docFolders', ['docs/git']),
          referenceUrls: config.get('claude.referenceUrls', []),
          timeout: config.get('claude.timeoutSeconds', 90) * 1000,
          signal: this.abort.signal,
        });
        if (epoch !== this.epoch || this.disposed) return;
        this.state.report = report;
        this.state.message = `Claude suggestions ready · ${report.sha.slice(0, 7)} · ${report.ref}`;
        void vscode.window.showInformationMessage(`Git Genie: Claude suggestions ready for ${report.sha.slice(0, 7)}.`, 'View suggestions').then(choice => {
          if (choice === 'View suggestions' && epoch === this.epoch && !this.disposed) void this.show(report);
        });
      } catch (error) {
        if (epoch !== this.epoch || this.disposed) return;
        this.failed = true;
        this.state.message = error.message;
        this.companion.output.appendLine(`Claude review: ${error.message}`);
      } finally {
        if (epoch === this.epoch && !this.disposed) { this.state.busy = false; this.publish(); }
      }
    }
  }

  async show(report = this.state.report) {
    if (!report) return;
    const content = ['GIT GENIE · CLAUDE SUGGESTIONS', `${report.ref} · ${report.sha}`, '', report.text,
      '', 'CONTEXT SOURCES', ...report.sources, '', 'CONTEXT LIMITS', ...report.limitations,
      '', 'Advisory only. Review suggestions before acting. No files or Git history were changed.'].join('\n');
    const document = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  dispose() { this.disposed = true; this.epoch++; this.abort?.abort(); this.queue = []; }
}

module.exports = { Advisor };
