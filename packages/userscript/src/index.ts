import {
  BitbucketDataCenterAdapter,
  BitbucketDataCenterBridgeServer,
} from '@remote/bitbucket-datacenter-adapter';
import { disconnectBridgePort } from './bridge-port.js';
import { parseBitbucketPage } from './context.js';
import { createWorkbenchUrl, launchContextKey, resolveLaunchRef } from './launch.js';

declare const __VSCODE_STATIC_URL__: string;

// Kept inside the userscript bundle so a page script cannot enable unsafe writes.
const BLOCK_FILE_WRITES = true;
const launcherTag = 'remote-bitbucket-datacenter-vscode-launcher';
const workbenchUrl = new URL(__VSCODE_STATIC_URL__);

type Launch = { capability: string; child: Window; origin: string; contextPath: string };
let activeLaunch: Launch | undefined;
let activePort: MessagePort | undefined;

function randomCapability(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function connect(event: MessageEvent<unknown>): void {
  const launch = activeLaunch;
  if (!launch || event.origin !== workbenchUrl.origin || event.source !== launch.child) return;
  const value = event.data;
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { type?: unknown }).type !== 'remote-bb-dc-connect' ||
    (value as { version?: unknown }).version !== 1 ||
    (value as { capability?: unknown }).capability !== launch.capability
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  const apiUrl = new URL(`${launch.contextPath}/rest/api/1.0/`, launch.origin).toString();
  disconnectBridgePort(activePort);
  activePort = port;
  new BitbucketDataCenterBridgeServer(new BitbucketDataCenterAdapter({ apiBaseUrl: apiUrl }), {
    writeFiles: !BLOCK_FILE_WRITES,
    manageBranches: true,
    createPullRequests: true,
    statuses: false,
    pipelines: false,
  }).attach(port);
}

function synchronize(): void {
  const context = parseBitbucketPage(new URL(location.href));
  const existing = document.querySelector(launcherTag);
  if (!context) {
    existing?.remove();
    return;
  }
  const contextKey = launchContextKey(context);
  if (existing?.getAttribute('data-context') === contextKey) return;
  existing?.remove();
  const host = document.createElement(launcherTag);
  host.setAttribute('data-context', contextKey);
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Open VS Code';
  Object.assign(host.style, { position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647' });
  button.addEventListener('click', () => {
    const capability = randomCapability();
    const child = window.open('about:blank', '_blank');
    if (!child) {
      button.textContent = 'Allow popups to open VS Code';
      return;
    }
    button.textContent = 'Resolving repository branch…';
    void resolveLaunchRef(context)
      .then((ref) => {
        activeLaunch = { capability, child, origin: context.origin, contextPath: context.contextPath };
        child.location.replace(createWorkbenchUrl(workbenchUrl, context, ref, capability).toString());
        button.textContent = 'VS Code opened';
      })
      .catch(() => {
        child.close();
        button.textContent = 'Could not resolve default branch';
      });
  });
  root.append(button);
  document.documentElement.append(host);
}

function observePage(): void {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      synchronize();
    });
  };
  for (const event of ['popstate', 'hashchange']) window.addEventListener(event, schedule);
  const pushState = history.pushState.bind(history);
  history.pushState = (...arguments_) => {
    pushState(...arguments_);
    schedule();
  };
  const replaceState = history.replaceState.bind(history);
  history.replaceState = (...arguments_) => {
    replaceState(...arguments_);
    schedule();
  };
  schedule();
}

window.addEventListener('message', connect);
window.addEventListener('pagehide', () => {
  disconnectBridgePort(activePort);
  activePort = undefined;
});
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', observePage, { once: true });
else observePage();
