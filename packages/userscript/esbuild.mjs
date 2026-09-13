import { build } from 'esbuild';

const builds = [
  build({
    entryPoints: ['src/demo-bootstrap.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/demo-bootstrap.js',
  }),
];

if (!process.argv.includes('--demo-only')) {
  const bootstrapUrl = new URL(requiredEnvironment('BITBUCKET_BOOTSTRAP_URL'));
  const bootstrapIntegrity = requiredEnvironment('BITBUCKET_BOOTSTRAP_INTEGRITY');
  const contextPath = normalizeContextPath(process.env.BITBUCKET_CONTEXT_PATH ?? '');
  const match = `${bootstrapUrl.origin}${contextPath}/*`;
  if (!/^sha384-[A-Za-z0-9+/]{64}$/u.test(bootstrapIntegrity)) {
    throw new Error('BITBUCKET_BOOTSTRAP_INTEGRITY must be a base64 SHA-384 Subresource Integrity value.');
  }
  const pinnedRef = bootstrapUrl.searchParams.get('at') ?? '';
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(pinnedRef)) {
    throw new Error('BITBUCKET_BOOTSTRAP_URL must use ?at=<full-commit-id>, not a moving branch or tag.');
  }
  builds.push(
    build({
      entryPoints: ['src/index.ts'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      outfile: 'dist/bitbucket-vscode.user.js',
      define: {
        __BITBUCKET_BOOTSTRAP_INTEGRITY__: JSON.stringify(bootstrapIntegrity),
        __BITBUCKET_BOOTSTRAP_URL__: JSON.stringify(bootstrapUrl.toString()),
        __BITBUCKET_CONTEXT_PATH__: JSON.stringify(contextPath),
      },
      banner: {
        js: `// ==UserScript==
// @name         Bitbucket Data Center VS Code
// @namespace    universal-remote-repositories
// @version      0.1.0
// @description  Opens a same-origin isolated editor shell on Bitbucket Data Center repository pages.
// @match        ${match}
// @run-at       document-start
// @grant        none
// ==/UserScript==`,
      },
    }),
  );
}

await Promise.all(builds);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeContextPath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  if (!trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('BITBUCKET_CONTEXT_PATH must be an absolute path such as /bitbucket.');
  }
  return trimmed.replace(/\/+$/u, '');
}
