'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { Git } = require('../vscode-extension/src/git');

const root = path.resolve(__dirname, '..');

async function main() {
  const simulations = path.join(root, 'simulations');
  await fs.mkdir(simulations, { recursive: true });
  const session = await fs.mkdtemp(path.join(simulations, 'shipping-shop-'));
  const repo = path.join(session, 'your-project');
  const teammate = path.join(session, 'dev-2');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(path.join(repo, 'test'));
  const git = new Git(repo);
  await git.run(['init', '-b', 'main']);
  await git.run(['config', 'user.name', 'You']);
  await git.run(['config', 'user.email', 'you@example.test']);
  await git.run(['config', 'commit.gpgsign', 'false']);
  await git.run(['config', 'core.autocrlf', 'false']);
  const initial = "'use strict';\n\nfunction shippingTotal(subtotal) {\n  if (!Number.isFinite(subtotal) || subtotal < 0) throw new RangeError('Subtotal must be a nonnegative number');\n  return subtotal + 5;\n}\n\nmodule.exports = { shippingTotal };\n";
  await fs.writeFile(path.join(repo, 'src', 'shipping.js'), initial);
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'genie-shipping-shop', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  await fs.writeFile(path.join(repo, 'test', 'shipping.test.js'), "'use strict';\nconst { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { shippingTotal } = require('../src/shipping');\ntest('standard shipping costs $5', () => assert.equal(shippingTotal(10), 15));\ntest('negative subtotals are rejected', () => assert.throws(() => shippingTotal(-1), RangeError));\n");
  await fs.writeFile(path.join(repo, 'README.md'), '# Shipping Shop — real Git simulation\n\nThis is a small working Node project created to test Git Genie. No remote is configured.\n\nYou are on `feature/free-shipping`. A second developer uses local `main` in the sibling `dev-2` worktree. Both names are simulated identities; the commits and Git history are real.\n\nRun `npm test` or `node --test`. Click the lamp in VS Code to see Genie compare this branch with `main`.\n\nYour feature adds free shipping at $50. Later, dev-2 changes the standard fee from $5 to $8 on the same line. Genie should flag `src/shipping.js`. The scenario leaves one staged TODO comment for you to inspect.\n\nTry: `git log --all --graph --oneline --decorate`, `git diff main...HEAD -- src/shipping.js`, and `git diff --cached`.\n');
  await git.run(['add', '.']);
  await git.run(['commit', '-m', 'Add checkout shipping calculation and tests']);
  await git.run(['checkout', '-b', 'feature/free-shipping']);
  await fs.writeFile(path.join(repo, 'src', 'shipping.js'), initial.replace('return subtotal + 5;', 'return subtotal >= 50 ? subtotal : subtotal + 5;'));
  await fs.appendFile(path.join(repo, 'test', 'shipping.test.js'), "test('free shipping begins at $50', () => assert.equal(shippingTotal(50), 50));\ntest('higher subtotals also ship free', () => assert.equal(shippingTotal(100), 100));\n");
  await git.run(['add', '.']);
  await git.run(['commit', '-m', 'Add free shipping for orders of $50 or more']);
  await git.run(['worktree', 'add', teammate, 'main']);
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });

  const extensionRoot = path.join(process.env.USERPROFILE, '.vscode', 'extensions');
  const extensions = (await fs.readdir(extensionRoot)).filter(name => name.startsWith('gitgenie-local.git-genie-')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!extensions.length) throw new Error('Install the Git Genie VSIX before running this simulation.');
  const installedExtension = path.join(extensionRoot, extensions.at(-1));
  const metadata = JSON.parse(await fs.readFile(path.join(installedExtension, 'package.json'), 'utf8'));
  const manifest = { repo, teammate, session, installedExtension, extensionVersion: metadata.version, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'artifacts', 'real-git-simulation-session.json'), JSON.stringify(manifest, null, 2));

  const userData = path.join(session, 'vscode-test-user');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none', 'window.newWindowDimensions': 'maximized',
  }));
  const executable = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  const env = { ...process.env, GENIE_SIMULATION_REPO: repo, GENIE_SIMULATION_TEAMMATE: teammate, GENIE_SIMULATION_MANIFEST: path.join(root, 'artifacts', 'real-git-simulation-session.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Created your project: ${repo}`);
  console.log(`Created dev-2's worktree: ${teammate}`);
  console.log(`Testing the INSTALLED Git Genie ${metadata.version} with its automatic 10-second checks.`);
  const child = spawn(executable, [
    '--user-data-dir', userData, '--extensions-dir', path.join(session, 'test-extensions'),
    '--extensionDevelopmentPath', installedExtension,
    '--extensionTestsPath', path.join(root, 'vscode-extension', 'test', 'simulation-host.js'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', repo,
  ], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
