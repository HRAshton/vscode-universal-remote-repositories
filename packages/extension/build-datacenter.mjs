import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

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
  }),
  copyFile('package.datacenter.json', `${outputDirectory}/package.json`),
  copyFile('README.datacenter.md', `${outputDirectory}/README.md`),
  copyFile('LICENSE', `${outputDirectory}/LICENSE`),
]);
