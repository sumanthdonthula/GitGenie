'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

class Git {
  constructor(repo) { this.repo = path.resolve(repo); }

  run(args, accepted = [0], options = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_EXTERNAL_DIFF']) delete env[key];
    return new Promise((resolve, reject) => {
      execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
        cwd: this.repo, env: { ...env, ...options.env }, windowsHide: true, timeout: options.timeout || 20000, maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (!error || accepted.includes(error.code)) return resolve(stdout);
        if (error.code === 'ENOENT') return reject(new Error('Install Git and restart VS Code to start watching.'));
        const failure = new Error(error.killed ? 'Git timed out. Check the repository state before retrying.' : stderr.trim() || stdout.trim() || error.message);
        failure.code = error.code;
        failure.output = `${stdout}\n${stderr}`.trim();
        reject(failure);
      });
    });
  }

  async exists(ref) {
    return Boolean((await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [0, 1])).trim());
  }

  async commits(revision, file, limit = 12) {
    const args = ['--literal-pathspecs', 'log', `-n${limit}`, '--format=%H%x00%an%x00%s%x00%aI', revision, '--'];
    if (file) args.push(file);
    return (await this.run(args)).split(/\r?\n/).filter(Boolean).map(line => {
      const [sha, author, subject, date] = line.split('\0');
      return { sha, author, subject, date };
    });
  }
}

const paths = output => output.split('\0').filter(Boolean);
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames'];

function spansOverlap(a, b) {
  if (!a.count && !b.count) return a.start === b.start;
  if (!a.count) return b.start - 1 <= a.start && a.start <= b.start + b.count - 1;
  if (!b.count) return a.start - 1 <= b.start && b.start <= a.start + a.count - 1;
  return Math.max(a.start, b.start) <= Math.min(a.start + a.count - 1, b.start + b.count - 1);
}

function parsePatch(patch) {
  const spans = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)]
    .map(match => ({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) }));
  const structural = /^(?:deleted file mode|new file mode|old mode|new mode|Binary files|GIT binary patch)/m.test(patch);
  return { spans, structural };
}

async function changes(git, ancestor, target, cached = false) {
  const revisions = [ancestor, ...(target ? [target] : [])];
  const options = cached ? ['--cached'] : [];
  const names = paths(await git.run(['diff', '--name-only', '-z', '--no-renames', ...options, ...revisions, '--']));
  const result = new Map();
  // Serial Git processes keep large repositories from flooding the machine.
  for (const name of names) {
    const patch = await git.run(['--literal-pathspecs', 'diff', ...diffOptions, '--unified=0', ...options, ...revisions, '--', name]);
    result.set(name, parsePatch(patch));
  }
  return result;
}

async function inspect(repo, requestedBase = '', preferredRemote = 'origin') {
  let git = new Git(repo);
  const root = (await git.run(['rev-parse', '--show-toplevel'])).trim();
  git = new Git(root);
  const startHead = (await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])).trim();
  let branch = (await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim();
  branch ||= startHead ? `detached @ ${startHead.slice(0, 7)}` : 'new branch';
  const untracked = paths(await git.run(['ls-files', '--others', '--exclude-standard', '-z']));
  const snapshot = {
    root, branch, base: null, latest: null, incoming: [], overlaps: [], ahead: 0, behind: 0,
    dirtyFiles: 0, untrackedFiles: untracked.length, changedFiles: 0, checkedAt: new Date().toISOString(),
  };
  if (!startHead) {
    snapshot.dirtyFiles = paths(await git.run(['diff', '--cached', '--name-only', '-z', '--'])).length;
    return { ...snapshot, message: 'Make your first commit and I’ll start watching.' };
  }
  snapshot.latest = (await git.commits('HEAD', null, 1))[0];
  const dirty = paths(await git.run(['diff', 'HEAD', '--name-only', '-z', '--']));
  const staged = paths(await git.run(['diff', '--cached', 'HEAD', '--name-only', '-z', '--']));
  snapshot.dirtyFiles = new Set([...dirty, ...staged]).size;
  let base = requestedBase;
  if (base) {
    if (base.startsWith('-') || !await git.exists(base)) throw new Error(`Comparison branch “${base}” wasn’t found. Choose another branch.`);
  } else {
    for (const candidate of [`${preferredRemote}/main`, `${preferredRemote}/master`, 'main', 'master']) {
      if (await git.exists(candidate.includes('/') ? `refs/remotes/${candidate}` : `refs/heads/${candidate}`)) { base = candidate; break; }
    }
  }
  if (!base) return { ...snapshot, message: 'Choose a comparison branch. I couldn’t find main or master.' };
  snapshot.base = base;
  const ancestor = (await git.run(['merge-base', 'HEAD', base], [0, 1])).trim();
  if (!ancestor) throw new Error(`${branch} and ${base} don’t share Git history.`);
  [snapshot.ahead, snapshot.behind] = (await git.run(['rev-list', '--left-right', '--count', `HEAD...${base}`, '--'])).trim().split(/\s+/).map(Number);
  snapshot.incoming = snapshot.behind ? await git.commits(`HEAD..${base}`) : [];
  const ours = await changes(git, ancestor);
  if (staged.length) {
    const index = await changes(git, ancestor, null, true);
    for (const name of staged) {
      if (!index.has(name)) continue;
      const indexed = index.get(name);
      if (ours.has(name)) {
        ours.get(name).spans.push(...indexed.spans);
        ours.get(name).structural ||= indexed.structural;
      } else ours.set(name, indexed);
    }
  }
  const theirs = await changes(git, ancestor, base);
  for (const name of untracked) ours.set(name, { spans: [], structural: true });
  snapshot.changedFiles = ours.size;
  for (const name of [...ours.keys()].sort()) {
    if (!theirs.has(name)) continue;
    if (!untracked.includes(name)) {
      const workDiff = await git.run(['--literal-pathspecs', 'diff', ...diffOptions, base, '--', name]);
      const indexDiff = staged.includes(name)
        ? await git.run(['--literal-pathspecs', 'diff', '--cached', ...diffOptions, base, '--', name]) : '';
      if (!workDiff && !indexDiff) continue;
    }
    const local = ours.get(name), incoming = theirs.get(name);
    const lineOverlap = local.spans.some(a => incoming.spans.some(b => spansOverlap(a, b)));
    const kind = local.structural || incoming.structural ? 'file collision' : lineOverlap ? 'same lines' : 'same file';
    const commits = await git.commits(`${ancestor}..${base}`, name, 8);
    snapshot.overlaps.push({ path: name, kind, authors: [...new Set(commits.map(c => c.author))], commits });
  }
  // A branch switch during an analysis invalidates the result instead of showing mixed history.
  const endHead = (await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])).trim();
  const endBranch = (await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim();
  if (endHead !== startHead || (endBranch && endBranch !== branch)) throw new Error('Your branch changed while I was checking. Checking again shortly.');
  snapshot.message = snapshot.overlaps.some(o => o.kind !== 'same file')
    ? 'A little heads-up: your changes overlap. Review before a possible rebase.'
    : snapshot.overlaps.length ? 'You’re working in the same files. Take a look before syncing.'
      : snapshot.behind ? `${base} has ${snapshot.behind} newer commit${snapshot.behind === 1 ? '' : 's'}. Ready when you are.`
        : `All clear. I’m watching your branch.`;
  return snapshot;
}

function alertKey(snapshot) {
  return JSON.stringify([snapshot.root, snapshot.branch, snapshot.base,
    snapshot.incoming.map(c => c.sha), snapshot.overlaps.map(o => [o.path, o.kind, o.authors])]);
}

function demoSnapshot() {
  return {
    demo: true, root: 'Genie playground', branch: 'feature/free-shipping', base: 'main',
    latest: { sha: 'a71b9e2', author: 'You', subject: 'Add free shipping over $50', date: '' },
    incoming: [{ sha: 'b93f201', author: 'dev-2', subject: 'Update standard shipping fee', date: '' }],
    overlaps: [{ path: 'src/checkout.ts', kind: 'same lines', authors: ['dev-2'], commits: [] }],
    ahead: 1, behind: 1, dirtyFiles: 1, untrackedFiles: 0, changedFiles: 2,
    message: 'dev-2 changed the same lines. Let’s review before a rebase.',
  };
}

module.exports = { Git, inspect, spansOverlap, parsePatch, alertKey, demoSnapshot };
