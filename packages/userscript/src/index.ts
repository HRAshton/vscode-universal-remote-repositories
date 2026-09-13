import { type BitbucketPageContext, createShellUrl, parseBitbucketPage, parseShellPage } from './context.js';

declare const __BITBUCKET_BOOTSTRAP_INTEGRITY__: string;
declare const __BITBUCKET_BOOTSTRAP_URL__: string;
declare const __BITBUCKET_CONTEXT_PATH__: string;

declare global {
  interface Window {
    __REMOTE_VSCODE_CONTEXT__?: Readonly<BitbucketPageContext>;
  }
}

const initialUrl = new URL(location.href);
const initialShellContext = parseShellPage(initialUrl);
if (initialShellContext && initialShellContext.contextPath === __BITBUCKET_CONTEXT_PATH__) {
  startShell(initialShellContext);
} else {
  onDocumentReady(installPageObserver);
}

function startShell(context: BitbucketPageContext): void {
  window.stop();
  document.documentElement.replaceChildren();
  const head = document.createElement('head');
  const body = document.createElement('body');
  document.documentElement.append(head, body);
  document.title = 'VS Code - Bitbucket';
  Object.assign(body.style, { margin: '0', minHeight: '100vh', background: '#181818', color: '#ddd' });
  Object.defineProperty(window, '__REMOTE_VSCODE_CONTEXT__', {
    configurable: false,
    enumerable: true,
    value: Object.freeze(context),
    writable: false,
  });
  loadBootstrap(body);
}

function loadBootstrap(parent: HTMLElement): void {
  const url = new URL(__BITBUCKET_BOOTSTRAP_URL__);
  if (url.origin !== location.origin) {
    showMessage(parent, 'The configured bootstrap module is not on this Bitbucket origin.');
    return;
  }
  const script = document.createElement('script');
  script.type = 'module';
  script.src = url.toString();
  script.integrity = __BITBUCKET_BOOTSTRAP_INTEGRITY__;
  script.addEventListener('error', () => {
    showMessage(
      parent,
      'The bootstrap module was blocked or failed to load. Check its raw URL, MIME type, and Bitbucket CSP.',
    );
  });
  document.head.append(script);
}

function installPageObserver(): void {
  let activeKey = '';
  let scheduled = false;
  const synchronize = () => {
    scheduled = false;
    const context = parseBitbucketPage(new URL(location.href));
    const nextKey = context ? JSON.stringify(context) : '';
    const existing = document.querySelector('remote-vscode-launcher');
    if (!context || context.contextPath !== __BITBUCKET_CONTEXT_PATH__) {
      existing?.remove();
      activeKey = '';
      return;
    }
    if (nextKey === activeKey && existing) return;
    existing?.remove();
    installLauncher(context);
    activeKey = nextKey;
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(synchronize);
  };
  window.addEventListener('hashchange', schedule);
  window.addEventListener('popstate', schedule);
  const pushState = history.pushState.bind(history);
  history.pushState = (...arguments_: Parameters<History['pushState']>) => {
    pushState(...arguments_);
    schedule();
  };
  const replaceState = history.replaceState.bind(history);
  history.replaceState = (...arguments_: Parameters<History['replaceState']>) => {
    replaceState(...arguments_);
    schedule();
  };
  synchronize();
}

function installLauncher(context: BitbucketPageContext): void {
  if (document.querySelector('remote-vscode-launcher')) return;
  const host = document.createElement('remote-vscode-launcher');
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  const iframe = document.createElement('iframe');
  button.type = 'button';
  button.textContent = 'Open VS Code';
  button.setAttribute('aria-expanded', 'false');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  Object.assign(button.style, {
    position: 'absolute',
    top: '12px',
    right: '12px',
    zIndex: '2',
    padding: '8px 12px',
    pointerEvents: 'auto',
  });
  Object.assign(iframe.style, {
    border: '0',
    display: 'none',
    height: '100vh',
    width: '100vw',
    pointerEvents: 'auto',
  });
  iframe.title = `VS Code for ${context.project}/${context.repository}`;
  iframe.src = createShellUrl(context).toString();
  button.addEventListener('click', () => {
    const opening = iframe.style.display === 'none';
    iframe.style.display = opening ? 'block' : 'none';
    button.textContent = opening ? 'Close VS Code' : 'Open VS Code';
    button.setAttribute('aria-expanded', String(opening));
  });
  root.append(iframe, button);
  document.documentElement.append(host);
}

function showMessage(parent: HTMLElement, message: string): void {
  const element = document.createElement('p');
  element.textContent = message;
  element.setAttribute('role', 'alert');
  Object.assign(element.style, {
    fontFamily: 'sans-serif',
    margin: '10vh auto',
    maxWidth: '720px',
    padding: '24px',
  });
  parent.append(element);
}

function onDocumentReady(action: () => void): void {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', action, { once: true });
  else action();
}
