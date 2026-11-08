'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Git } = require('../src/git');

async function createFixture(root) {
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.access(path.join(root, '.git'));
    return root;
  } catch { /* Initialize only new fixtures. */ }
  const git = new Git(root);
  await git.run(['init', '-b', 'main']);
  await git.run(['config', 'user.name', 'You']);
  await git.run(['config', 'user.email', 'you@example.test']);
  await git.run(['config', 'commit.gpgsign', 'false']);
  await git.run(['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(root, 'README.md'), '# Genie playground\n\nLocal example: your feature branch and dev-2 on main edit the same shipping calculation.\n');
  await fs.writeFile(path.join(root, 'checkout.ts'), 'export function shippingTotal(subtotal: number) {\n  return subtotal + 5;\n}\n');
  await git.run(['add', '.']); await git.run(['commit', '-m', 'Add shipping calculation']);
  await git.run(['checkout', '-b', 'feature/free-shipping']);
  await fs.writeFile(path.join(root, 'checkout.ts'), 'export function shippingTotal(subtotal: number) {\n  return subtotal > 50 ? subtotal : subtotal + 5;\n}\n');
  await git.run(['commit', '-am', 'Add free shipping over $50']);
  await git.run(['checkout', 'main']);
  await fs.writeFile(path.join(root, 'checkout.ts'), 'export function shippingTotal(subtotal: number) {\n  return subtotal + 8;\n}\n');
  await git.run(['-c', 'user.name=dev-2', 'commit', '-am', 'Update standard shipping fee']);
  await git.run(['checkout', 'feature/free-shipping']);
  return root;
}

module.exports = { createFixture };
if (require.main === module) createFixture(path.resolve(__dirname, '..', '..', '.vscode-test', 'playground')).then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
