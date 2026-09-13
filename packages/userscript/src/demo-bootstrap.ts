import type { BitbucketPageContext } from './context.js';

declare global {
  interface Window {
    __REMOTE_VSCODE_CONTEXT__?: Readonly<BitbucketPageContext>;
  }
}

const context = window.__REMOTE_VSCODE_CONTEXT__;
if (!context) throw new Error('The userscript did not provide repository context.');

const main = document.createElement('main');
const heading = document.createElement('h1');
const status = document.createElement('p');
const details = document.createElement('pre');
heading.textContent = 'Data Center host test';
status.textContent = 'Checking the current Bitbucket browser session…';
details.textContent = JSON.stringify(context, null, 2);
Object.assign(main.style, {
  fontFamily: 'sans-serif',
  margin: '10vh auto',
  maxWidth: '800px',
  padding: '24px',
});
main.append(heading, status, details);
document.body.replaceChildren(main);

const repositoryPath = `projects/${encodeURIComponent(context.project)}/repos/${encodeURIComponent(context.repository)}`;
const apiUrl = new URL(
  `${context.contextPath}/rest/api/1.0/${repositoryPath}/branches/default`,
  context.origin,
);

try {
  const response = await fetch(apiUrl, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  if (!response.ok || response.status >= 300) throw new Error(`Bitbucket returned HTTP ${response.status}.`);
  const branch = (await response.json()) as { displayId?: unknown; latestCommit?: unknown };
  if (typeof branch.displayId !== 'string' || typeof branch.latestCommit !== 'string') {
    throw new Error('Bitbucket returned an invalid default branch.');
  }
  const browseUrl = new URL(
    `${context.contextPath}/rest/api/1.0/${repositoryPath}/browse?at=${encodeURIComponent(branch.latestCommit)}&limit=1`,
    context.origin,
  );
  const browseResponse = await fetch(browseUrl, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  if (!browseResponse.ok || browseResponse.status >= 300) {
    throw new Error(`Bitbucket browse API returned HTTP ${browseResponse.status}.`);
  }
  const browse = (await browseResponse.json()) as { children?: { values?: unknown } };
  if (!Array.isArray(browse.children?.values)) {
    throw new Error('Bitbucket returned incompatible browse API data.');
  }
  const propertiesUrl = new URL(`${context.contextPath}/rest/api/1.0/application-properties`, context.origin);
  const propertiesResponse = await fetch(propertiesUrl, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  let version = 'unknown';
  if (propertiesResponse.ok && propertiesResponse.status < 300) {
    const properties = (await propertiesResponse.json()) as { version?: unknown };
    if (typeof properties.version === 'string') version = properties.version;
  }
  status.textContent =
    `Session and REST shape confirmed for Bitbucket ${version}. ` +
    `Default branch: ${branch.displayId} (${branch.latestCommit}); ` +
    `${browse.children.values.length} root entry sampled.`;
  status.style.color = '#73c991';
} catch (cause) {
  status.textContent = cause instanceof Error ? cause.message : 'The session check failed.';
  status.style.color = '#f48771';
}
