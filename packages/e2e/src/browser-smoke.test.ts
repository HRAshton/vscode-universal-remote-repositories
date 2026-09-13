import { open, type Disposable } from '@vscode/test-web';
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = 3100;
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(sourceDirectory, '../../extension');
let server: Disposable;

test.beforeAll(async () => {
  server = await open({
    browserType: 'none',
    extensionDevelopmentPath,
    folderUri: 'remote://fake/demo?ref=main',
    quality: 'stable',
    version: '1.103.2',
    host: 'localhost',
    port,
  });
});

test.afterAll(() => {
  server.dispose();
});

test('loads VS Code Web, activates extension, and lists remote files', async ({ page }) => {
  await page.goto(`http://localhost:${port}`);
  await expect(page.locator('.monaco-workbench')).toBeVisible();
  await expect(page.getByText('README.md', { exact: true }).first()).toBeVisible();
});
