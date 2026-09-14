import { build } from 'esbuild';

const workbenchUrl = new URL(process.env.VSCODE_STATIC_URL ?? 'http://localhost:8080/');
if (!['http:', 'https:'].includes(workbenchUrl.protocol)) {
  throw new Error('VSCODE_STATIC_URL must be an HTTP(S) URL.');
}
const configuredBitbucketUrl = process.env.BITBUCKET_URL?.trim();
const match = configuredBitbucketUrl ? `${validatedOrigin(configuredBitbucketUrl)}/*` : '*://*/*';

await Promise.all([
  build({
    entryPoints: ['./src/index.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: './dist/bitbucket-vscode.user.js',
    define: { __VSCODE_STATIC_URL__: JSON.stringify(workbenchUrl.toString()) },
    banner: {
      js: `// ==UserScript==
// @name         Bitbucket Data Center VS Code
// @namespace    universal-remote-repositories
// @version      0.1.0-alpha.2
// @description  Opens a local VS Code workbench connected to this Bitbucket Data Center tab.
// @match        ${match}
// @run-at       document-start
// @grant        none
// ==/UserScript==`,
    },
  }),
  build({
    entryPoints: ['./src/workbench-relay.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: './dist/bitbucket-vscode-workbench-relay.js',
  }),
]);

function validatedOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('BITBUCKET_URL must be an HTTP(S) URL.');
  }
  return url.origin;
}
