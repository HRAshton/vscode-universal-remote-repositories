import { describe, expect, it } from 'vitest';
import {
  createShellUrl,
  isShellPage,
  parseBitbucketPage,
  parseShellContext,
  parseShellPage,
} from './context.js';

describe('Bitbucket Data Center userscript context', () => {
  it('parses root and context-path repository URLs', () => {
    expect(parseBitbucketPage(new URL('https://stash.test/projects/APP/repos/web/browse?at=main'))).toEqual({
      provider: 'bitbucket-datacenter',
      origin: 'https://stash.test',
      contextPath: '',
      project: 'APP',
      repository: 'web',
      ref: 'main',
    });
    expect(
      parseBitbucketPage(new URL('https://stash.test/bitbucket/projects/APP/repos/web/pull-requests')),
    ).toMatchObject({ contextPath: '/bitbucket', project: 'APP', repository: 'web' });
  });

  it('round trips repository context through a same-origin fragment', () => {
    const context = parseBitbucketPage(
      new URL('https://stash.test/bitbucket/projects/APP/repos/web/browse?at=release%2Fone'),
    );
    expect(context).toBeDefined();
    if (!context) return;

    const shell = createShellUrl(context);

    expect(shell.pathname).toBe('/bitbucket/__remote-vscode__/');
    expect(isShellPage(shell)).toBe(true);
    expect(parseShellContext(shell)).toEqual(context);
  });

  it('rejects shell context copied to another origin', () => {
    const context = parseBitbucketPage(new URL('https://stash.test/projects/APP/repos/web/browse'));
    expect(context).toBeDefined();
    if (!context) return;
    const shell = createShellUrl(context);
    shell.host = 'evil.test';
    expect(parseShellContext(shell)).toBeUndefined();
  });

  it('does not treat an ordinary matching path as a runnable shell', () => {
    const url = new URL('https://stash.test/projects/APP/repos/web/browse/__remote-vscode__/');
    expect(isShellPage(url)).toBe(true);
    expect(parseShellPage(url)).toBeUndefined();
  });

  it('ignores malformed encoded repository paths', () => {
    expect(
      parseBitbucketPage(new URL('https://stash.test/projects/%E0%A4%A/repos/web/browse')),
    ).toBeUndefined();
  });
});
