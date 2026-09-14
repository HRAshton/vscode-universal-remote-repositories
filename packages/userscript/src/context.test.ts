import { describe, expect, it } from 'vitest';
import { parseBitbucketPage } from './context.js';

describe('Bitbucket Data Center page context', () => {
  it('parses repository pages at root and a context path', () => {
    expect(parseBitbucketPage(new URL('https://stash.test/projects/APP/repos/web/browse?at=main'))).toEqual({
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

  it('rejects malformed repository paths', () => {
    expect(
      parseBitbucketPage(new URL('https://stash.test/projects/%E0%A4%A/repos/web/browse')),
    ).toBeUndefined();
  });
});
