'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createFixture } = require('./create-fixture');
const { Git } = require('../src/git');

async function main() {
  const extensionPath = path.resolve(__dirname, '..');
  const root = path.resolve(extensionPath, '..', '.vscode-test');
  await fs.mkdir(root, { recursive: true });
  const session = await fs.mkdtemp(path.join(root, 'sync-host-'));
  const fixture = await createFixture(path.join(session, 'playground'));
  const remote = path.join(session, 'remote.git');
  await new Git(session).run(['init', '--bare', remote]);
  await new Git(fixture).run(['remote', 'add', 'origin', remote]);
  await new Git(fixture).run(['push', 'origin', 'main']);
  const userData = path.join(session, 'test-user');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none', 'window.newWindowDimensions': 'maximized',
  }));
  const executable = process.env.GENIE_VSCODE || path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    '--user-data-dir', userData, '--extensions-dir', path.join(session, 'test-extensions'),
    '--extensionDevelopmentPath', extensionPath, '--extensionTestsPath', path.join(__dirname, 'host.js'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', fixture,
  ], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
