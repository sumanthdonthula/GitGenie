'use strict';

const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Git, inspect, alertKey, demoSnapshot } = require('./git');
const { syncPlan, pullAndRebase, resumeRebase, operationState, fetchRemote } = require('./sync');

const VIEW = 'gitgenie.companion';
const SCAN_MS = 10000;
const FETCH_MS = 300000;

class Companion {
  constructor(context) {
    this.context = context;
    this.state = { mode: 'loading', message: 'Waking up your genie…', snapshot: null };
    this.repo = context.workspaceState.get('repository');
    this.generation = 0;
    this.previousAlert = null;
    this.busy = false;
    this.pending = false;
    this.disposed = false;
    this.snoozeUntil = 0;
    this.operation = false;
    this.sync = { busy: false, canSync: false, target: null, paused: false, message: '', reason: '' };
    this.fetchInfo = { enabled: false, lastFetch: null, error: '' };
    this.fetchTimes = new Map();
    this.output = vscode.window.createOutputChannel('Git Genie');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
    this.status.command = 'gitgenie.summon';
    this.status.name = 'Git Genie';
    this.status.text = '$(sparkle) Genie';
    this.status.tooltip = 'Rub the lamp · Git Genie';
    this.status.show();
    context.subscriptions.push(this.output, this.status, this);
  }

  config() {
    return vscode.workspace.getConfiguration('gitgenie', this.repo ? vscode.Uri.file(this.repo) : undefined);
  }

  async resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const media = file => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file)).toString();
    const nonce = crypto.randomBytes(24).toString('base64');
    let html = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'view.html'), 'utf8');
    html = html.replaceAll('{{csp}}', webview.cspSource).replaceAll('{{nonce}}', nonce)
      .replaceAll('{{css}}', media('view.css')).replaceAll('{{js}}', media('view.js'));
    webview.html = html;
    this.context.subscriptions.push(webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.type !== 'string') return;
      try {
        switch (message.type) {
          case 'ready': this.send(true); break;
          case 'summon': this.send(true); break;
          case 'refresh': this.leaveDemo(); await this.scan(); break;
          case 'demo': this.demo(); break;
          case 'repository': await this.chooseRepository(); break;
          case 'base': await this.chooseBase(); break;
          case 'snooze':
            this.snoozeUntil = Date.now() + 15 * 60 * 1000;
            this.send();
            break;
          case 'resume': this.snoozeUntil = 0; this.send(true); break;
          case 'details': await this.details(); break;
          case 'sync': await this.runSync('pull'); break;
          case 'continueRebase': await this.runSync('continue'); break;
          case 'abortRebase': await this.runSync('abort'); break;
        }
      } catch (error) { this.output.appendLine(error.message); }
    }));
    this.context.subscriptions.push(view.onDidChangeVisibility(() => { if (view.visible) this.send(); }));
    this.send(true);
  }

  send(animate = false) {
    if (this.disposed) return;
    this.view?.webview.postMessage({
      type: 'state', ...this.state, animate,
      sync: this.sync, fetchInfo: this.fetchInfo,
      animations: vscode.workspace.getConfiguration('gitgenie').get('animations', true), snoozed: Date.now() < this.snoozeUntil,
    });
  }

  async reveal(animate = true) {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${VIEW}.focus`);
    this.send(animate);
  }

  demo() {
    if (this.operation) return;
    this.generation++;
    this.state = { mode: 'demo', snapshot: demoSnapshot() };
    this.status.text = '$(sparkle) Genie · demo';
    this.send(true);
  }

  leaveDemo() {
    if (this.state.mode === 'demo') {
      this.generation++;
      this.state = { mode: 'loading', message: 'Checking your workspace…', snapshot: null };
      this.send();
    }
  }

  async repositories() {
    const roots = new Map();
    try {
      const builtin = vscode.extensions.getExtension('vscode.git');
      const api = builtin && (await builtin.activate()).getAPI(1);
      for (const repo of api?.repositories || []) roots.set(repo.rootUri.fsPath, repo.rootUri);
    } catch { /* Workspace folders also work when the built-in Git extension is disabled. */ }
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme === 'file') roots.set(folder.uri.fsPath, folder.uri);
    }
    return [...roots.values()];
  }

  async chooseRepository() {
    if (this.operation) return;
    const repos = await this.repositories();
    const browse = { label: '$(folder-opened) Browse for a repository…' };
    const pick = await vscode.window.showQuickPick([
      ...repos.map(uri => ({ label: path.basename(uri.fsPath), description: uri.fsPath, uri })), browse,
    ], { placeHolder: 'Which repository should your genie watch?' });
    if (!pick) return;
    let uri = pick.uri;
    if (!uri) {
      const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Choose a Git repository' });
      uri = folders?.[0];
    }
    if (!uri || uri.scheme !== 'file') return;
    if (!vscode.workspace.isTrusted) {
      vscode.window.showInformationMessage('Trust this workspace before enabling local Git analysis. The genie demo is available meanwhile.');
      return;
    }
    const root = (await new Git(uri.fsPath).run(['rev-parse', '--show-toplevel'])).trim();
    this.repo = root;
    await this.context.workspaceState.update('repository', root);
    this.generation++;
    this.previousAlert = null;
    this.sync = { busy: false, canSync: false, target: null, paused: false, message: '', reason: '' };
    this.fetchInfo = { enabled: false, lastFetch: null, error: '' };
    this.state = { mode: 'loading', message: 'Checking your selected repository…', snapshot: null };
    this.send();
    await this.scan();
  }

  async chooseBase() {
    if (this.operation) return;
    if (!this.repo) { await this.chooseRepository(); if (!this.repo) return; }
    if (!vscode.workspace.isTrusted) return;
    const branches = (await new Git(this.repo).run(['for-each-ref', '--format=%(refname:short)%00%(symref)', 'refs/heads/', 'refs/remotes/']))
      .trim().split(/\r?\n/).filter(Boolean).map(row => row.split('\0')).filter(row => !row[1]).map(row => row[0]);
    const branch = await vscode.window.showQuickPick(branches, { placeHolder: 'Compare against a local or remote tracking branch' });
    if (!branch) return;
    await this.config().update('baseBranch', branch, vscode.ConfigurationTarget.Workspace);
    this.generation++;
    this.previousAlert = null;
    this.leaveDemo();
    await this.scan();
  }

  async scan() {
    if (this.disposed || this.operation || this.state.mode === 'demo') return;
    if (this.busy) { this.pending = true; return; }
    this.busy = true;
    const generation = this.generation;
    try {
      if (!vscode.workspace.isTrusted) {
        this.state = { mode: 'welcome', message: 'Trust your workspace to watch Git, or try my demo.', snapshot: null };
        this.send();
        return;
      }
      if (!this.repo) this.repo = (await this.repositories())[0]?.fsPath;
      if (!this.repo) {
        this.state = { mode: 'welcome', message: 'Your wish, my git command. Choose a repository and I’ll keep watch.', snapshot: null };
        this.send();
        return;
      }
      const repo = this.repo;
      const remote = this.config().get('remote', 'origin');
      const git = new Git(repo);
      const active = await operationState(git);
      const remotes = (await git.run(['remote'])).trim().split(/\r?\n/).filter(Boolean);
      const autoFetch = this.config().get('autoFetch', true) && remotes.includes(remote);
      this.fetchInfo.enabled = autoFetch;
      const fetchKey = `${repo}\0${remote}`;
      if (!active && autoFetch && Date.now() - (this.fetchTimes.get(fetchKey) || 0) >= FETCH_MS) {
        this.fetchTimes.set(fetchKey, Date.now());
        try {
          await fetchRemote(repo, remote);
          this.fetchInfo.lastFetch = new Date().toISOString();
          this.fetchInfo.error = '';
        } catch (error) {
          this.fetchInfo.error = `Fetch failed; showing cached refs. ${error.message}`;
          this.output.appendLine(error.message);
        }
      }
      const snapshot = await inspect(repo, this.config().get('baseBranch', ''), remote);
      if (this.disposed || generation !== this.generation) return;
      this.repo = snapshot.root;
      this.sync.paused = active?.kind === 'rebase';
      this.sync.canSync = false;
      this.sync.reason = '';
      try {
        const plan = await syncPlan(repo, snapshot.base || '', remote);
        this.sync.target = plan.target;
        this.sync.canSync = !active && !snapshot.branch.startsWith('detached @');
      } catch (error) {
        this.sync.target = null;
        this.sync.reason = error.message;
      }
      if (this.disposed || generation !== this.generation) return;
      const key = alertKey(snapshot);
      const newAlert = snapshot.overlaps.length > 0 && key !== this.previousAlert;
      this.previousAlert = key;
      this.state = { mode: 'watching', snapshot };
      const count = snapshot.overlaps.length;
      this.status.text = `$(sparkle) Genie${count ? ` · ${count}` : ''}`;
      this.status.tooltip = `${snapshot.branch} vs ${snapshot.base || 'no base'} · ${snapshot.message}`;
      this.status.backgroundColor = count ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      if (newAlert && Date.now() >= this.snoozeUntil && vscode.workspace.getConfiguration('gitgenie').get('autoReveal', true)) {
        await this.reveal(true);
      } else this.send(newAlert && Date.now() >= this.snoozeUntil);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      const message = /not a git repository/.test(error.message)
        ? 'This folder isn’t a Git repository yet. Choose a repository, or try the demo.'
        : /dubious ownership/.test(error.message)
          ? 'Git reports a different owner for this folder. Choose a repository you own, or review its trust status in Source Control.'
          : error.message;
      this.state = { mode: 'error', message, snapshot: null };
      this.sync.canSync = false;
      this.sync.reason = message;
      this.status.text = '$(sparkle) Genie';
      this.status.tooltip = message;
      this.status.backgroundColor = undefined;
      this.send();
      this.output.appendLine(error.message);
    } finally {
      this.busy = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        void this.scan();
      }
    }
  }

  async runSync(action = 'pull') {
    if (this.operation || this.disposed) return;
    if (!vscode.workspace.isTrusted) {
      vscode.window.showInformationMessage('Trust this workspace before changing its Git history.');
      return;
    }
    if (this.state.mode === 'demo') {
      vscode.window.showInformationMessage('Return to your workspace before pulling and rebasing.');
      return;
    }
    if (!this.repo) { await this.chooseRepository(); if (!this.repo) return; }
    if (action === 'pull' && (this.state.mode !== 'watching' || !this.state.snapshot ||
        path.resolve(this.state.snapshot.root).toLowerCase() !== path.resolve(this.repo).toLowerCase())) {
      vscode.window.showInformationMessage('Wait for the selected repository check to finish before pulling and rebasing.');
      return;
    }
    const repo = this.repo;
    const dirtyBuffers = vscode.workspace.textDocuments.some(doc => {
      if (!doc.isDirty || doc.uri.scheme !== 'file') return false;
      const relative = path.relative(repo, doc.uri.fsPath);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
    if (dirtyBuffers) {
      this.sync.message = 'Save your open files before changing Git history.';
      this.send();
      vscode.window.showWarningMessage(this.sync.message);
      return;
    }
    this.operation = true;
    this.generation++;
    this.sync.busy = true;
    this.sync.message = action === 'pull' ? 'Preparing to pull and rebase…' : `${action === 'abort' ? 'Aborting' : 'Continuing'} rebase…`;
    this.send();
    try {
      const waitingSince = Date.now();
      while (this.busy) {
        if (Date.now() - waitingSince > 120000) throw new Error('The current Git check is still running. Try again when it finishes.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Git Genie', cancellable: false }, async progress => {
        let result;
        if (action === 'pull') {
          const plan = await syncPlan(repo, this.config().get('baseBranch', '') || this.state.snapshot?.base || '', this.config().get('remote', 'origin'));
          this.sync.target = plan.target;
          result = await pullAndRebase(repo, plan, message => {
            this.sync.message = message; progress.report({ message }); this.send();
          });
          if (result.backupRef) this.output.appendLine(`Original HEAD: ${result.originalHead}\nBackup: ${result.backupRef}`);
        } else result = await resumeRebase(repo, action);
        this.output.appendLine(result.output || 'Git operation completed.');
        this.sync.paused = result.status === 'paused';
        this.sync.message = result.status === 'paused'
          ? 'Rebase paused. Resolve conflicts in Source Control, stage the resolved files, then Continue Rebase. You can also Abort Rebase.'
          : action === 'abort' ? 'Rebase aborted. Your original branch is restored.'
            : action === 'continue' ? 'Rebase completed.' : `Pulled ${result.target} and rebased ${result.branch}.`;
        if (result.status === 'paused') {
          void vscode.window.showWarningMessage(this.sync.message, 'Open Source Control', 'View Log').then(async choice => {
            if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
            if (choice === 'View Log') this.output.show(true);
          });
        } else vscode.window.showInformationMessage(this.sync.message);
      });
    } catch (error) {
      this.sync.message = error.message;
      this.output.appendLine(error.output || error.message);
      vscode.window.showErrorMessage(`Git Genie: ${error.message}`);
    } finally {
      this.operation = false;
      this.sync.busy = false;
      this.sync.paused = (await operationState(new Git(repo)).catch(() => null))?.kind === 'rebase';
      this.send();
      await this.scan();
    }
  }

  async details() {
    const s = this.state.snapshot;
    if (!s) return;
    const lines = [
      `GIT GENIE${s.demo ? ' — SAMPLE DATA' : ''}`, '', `${s.root}`, `${s.branch} → ${s.base || 'no base'}`,
      `${s.ahead} ahead · ${s.behind} behind · ${s.dirtyFiles} edited · ${s.untrackedFiles} untracked`, '', s.message, '',
      'Overlap signals compare shared-ancestor line ranges. They are not a simulated merge.',
      'Renames are treated as delete/add. Unsaved editor buffers are not included.', '',
      'LATEST COMMIT ON YOUR BRANCH', s.latest ? `${s.latest.sha} · ${s.latest.author}\n${s.latest.subject}` : 'No commits yet.', '',
      'INCOMING COMMITS (latest 12)', ...s.incoming.map(c => `${c.sha.slice(0, 7)} · ${c.author} · ${c.subject}`), '',
      'OVERLAPPING FILES', ...s.overlaps.flatMap(o => [`${o.path} — ${o.kind}`, `By ${o.authors.join(', ')}`, ...o.commits.map(c => `  ${c.sha.slice(0, 7)} ${c.subject}`), '']),
      'Monitoring does not change your branch. Pull & Rebase fetches the selected remote base and rebases only when you click it.',
      'Commit or stash edits first. If conflicts occur, resolve and stage them, then Continue Rebase, or Abort Rebase.',
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: true });
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.saveTimer);
  }
}

async function activate(context) {
  const companion = new Companion(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW, companion, { webviewOptions: { retainContextWhenHidden: true } }));
  const command = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  command('gitgenie.summon', () => companion.reveal(true));
  command('gitgenie.refresh', async () => { companion.leaveDemo(); await companion.scan(); });
  command('gitgenie.demo', async () => { companion.demo(); await companion.reveal(true); });
  command('gitgenie.chooseRepository', () => companion.chooseRepository());
  command('gitgenie.chooseBase', () => companion.chooseBase());
  command('gitgenie.pullAndRebase', () => companion.runSync('pull'));
  command('gitgenie.continueRebase', () => companion.runSync('continue'));
  command('gitgenie.abortRebase', () => companion.runSync('abort'));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
    clearTimeout(companion.saveTimer);
    companion.saveTimer = setTimeout(() => void companion.scan(), 400);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('gitgenie')) {
      companion.generation++;
      companion.send();
      void companion.scan();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (companion.operation) return;
    companion.repo = undefined;
    companion.generation++;
    companion.previousAlert = null;
    companion.sync = { busy: false, canSync: false, target: null, paused: false, message: '', reason: '' };
    companion.state = { mode: 'loading', message: 'Checking your workspace…', snapshot: null };
    companion.send();
    void companion.scan();
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void companion.scan()));
  companion.timer = setInterval(() => void companion.scan(), SCAN_MS);
  if (!context.globalState.get('welcomed.v0.2')) {
    await companion.reveal(true);
    await context.globalState.update('welcomed.v0.2', true);
  }
  void companion.scan();
  return { getState: () => structuredClone({ ...companion.state, sync: companion.sync, fetchInfo: companion.fetchInfo }) };
}

module.exports = { activate };
