/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const send = type => vscode.postMessage({ type });
let animationTimer;
let previousSnapshot;

function summon() {
  clearTimeout(animationTimer);
  document.body.classList.remove('summoning');
  // Reflow restarts the sequence on every deliberate rub of the lamp.
  void document.body.offsetWidth;
  document.body.classList.add('summoning');
  animationTimer = setTimeout(() => document.body.classList.remove('summoning'), 2800);
}

function text(id, value) { byId(id).textContent = value; }

function render(state) {
  const s = state.snapshot;
  const demo = state.mode === 'demo';
  const sync = state.sync || {};
  document.body.classList.toggle('no-motion', !state.animations);
  document.body.classList.toggle('has-overlap', Boolean(s?.overlaps.length));
  text('mode', demo ? 'DEMO · SAMPLE DATA' : state.snoozed ? 'SNOOZED' : sync.target ? 'REMOTE READY' : 'LOCAL ONLY');
  text('report-title', demo ? 'A PEEK AT THE MAGIC' : 'YOUR BRANCH, UNDER MY WATCH');
  text('branch', s?.branch || 'Let’s make some magic.');
  text('counts', s ? `vs ${s.base || 'choose base'}  ·  ${s.ahead} ahead / ${s.behind} behind  ·  ${s.dirtyFiles} edited` : 'Local branches. No account needed.');
  text('message', s?.message || state.message || 'Choose a repository and I’ll keep watch.');
  const speech = s?.overlaps.length
    ? `${s.overlaps[0].authors.join(', ') || 'A teammate'} touched your code. I’ve got the details.`
    : s ? 'Your branch has a little guardian now.'
      : 'Your wish, my git command.';
  if (previousSnapshot !== JSON.stringify([s?.branch, s?.overlaps, state.mode])) text('speech', speech);
  previousSnapshot = JSON.stringify([s?.branch, s?.overlaps, state.mode]);
  text('assessment-icon', s?.overlaps.length ? '✧' : '✦');
  byId('live-dot').classList.toggle('idle', state.mode !== 'watching');
  byId('commit').hidden = !s?.latest;
  if (s?.latest) {
    text('commit-subject', s.latest.subject);
    text('commit-meta', `${s.latest.sha.slice(0, 7)}  ·  ${s.latest.author}`);
  }
  byId('overlaps').replaceChildren();
  for (const overlap of s?.overlaps.slice(0, 3) || []) {
    const card = document.createElement('div');
    card.className = 'overlap';
    const who = document.createElement('span');
    who.className = 'who'; who.textContent = `${overlap.authors.join(', ') || 'A teammate'} made changes`;
    const file = document.createElement('span');
    file.className = 'file'; file.textContent = overlap.path;
    const risk = document.createElement('span');
    risk.className = 'risk';
    risk.textContent = overlap.kind === 'same file' ? 'Same file · review suggested' : `${overlap.kind === 'same lines' ? 'Same lines' : 'File collision'} · possible rebase conflict`;
    card.append(who, file, risk);
    byId('overlaps').append(card);
  }
  if (s?.overlaps.length > 3) {
    const more = document.createElement('div'); more.className = 'more';
    more.textContent = `+ ${s.overlaps.length - 3} more in Details`;
    byId('overlaps').append(more);
  }
  const incoming = s?.incoming[0];
  byId('incoming').hidden = !incoming;
  if (incoming) {
    text('incoming-title', `LATEST ON ${s.base}`);
    text('incoming-subject', incoming.subject);
    text('incoming-meta', `${incoming.sha.slice(0, 7)}  ·  ${incoming.author}`);
  }
  text('refresh', demo ? 'Watch my workspace ↗' : 'Check changes ↗');
  byId('details').disabled = !s;
  text('sync', sync.busy ? 'Working…' : 'Pull & Rebase ↻');
  byId('sync').disabled = demo || sync.busy || !sync.canSync || sync.paused;
  byId('sync').title = sync.target ? `Fetch ${sync.target} and rebase your current branch onto it. Commit or stash changes first.` : sync.reason || 'Choose a repository with a remote';
  text('sync-target', demo ? 'Available in a real repository with a remote' : sync.target ? `onto ${sync.target} · runs only when clicked` : sync.reason || 'Choose a repository with a remote');
  byId('rebase-actions').hidden = !sync.paused || demo;
  byId('continueRebase').disabled = sync.busy;
  byId('abortRebase').disabled = sync.busy;
  text('sync-message', demo ? '' : sync.message || '');
  byId('sync-message').hidden = demo || !sync.message;
  for (const id of ['refresh', 'repository', 'base', 'demo']) byId(id).disabled = Boolean(sync.busy);
  text('snooze', state.snoozed ? 'Resume' : 'Snooze');
  byId('snooze').onclick = () => send(state.snoozed ? 'resume' : 'snooze');
  text('watch-status', demo ? 'Sample data · your repository is unchanged' : state.snoozed ? 'Alerts paused for 15m · checks continue' : state.fetchInfo?.enabled ? 'Checks every 10s · fetch every 5m' : 'Checks every 10s · automatic fetch off');
  if (state.fetchInfo?.error && !demo && !sync.message) {
    text('sync-message', state.fetchInfo.error);
    byId('sync-message').hidden = false;
  }
  if (state.animate) summon();
}

for (const type of ['refresh', 'details', 'demo', 'repository', 'base', 'sync', 'continueRebase', 'abortRebase']) {
  byId(type).addEventListener('click', () => send(type));
}
byId('lamp').addEventListener('click', () => { summon(); send('summon'); });
window.addEventListener('message', event => { if (event.data?.type === 'state') render(event.data); });
send('ready');
