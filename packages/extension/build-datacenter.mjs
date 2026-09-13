import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const contextPath = normalizeContextPath(process.env.BITBUCKET_CONTEXT_PATH ?? '');
const outputDirectory = 'dist/datacenter';

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/datacenter-extension.ts'],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    external: ['vscode'],
    outfile: `${outputDirectory}/extension.js`,
    define: { __BITBUCKET_CONTEXT_PATH__: JSON.stringify(contextPath) },
  }),
  copyFile('package.datacenter.json', `${outputDirectory}/package.json`),
  copyFile('README.datacenter.md', `${outputDirectory}/README.md`),
  copyFile('LICENSE', `${outputDirectory}/LICENSE`),
]);

function normalizeContextPath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  if (!trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('BITBUCKET_CONTEXT_PATH must be an absolute path such as /bitbucket.');
  }
  return trimmed.replace(/\/+$/u, '');
}
