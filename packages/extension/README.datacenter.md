# Universal Remote Repositories for Bitbucket Data Center

This browser extension connects to the Bitbucket Data Center tab that opened it. The tab's userscript makes
same-origin REST requests with the current browser session; the workbench receives only typed repository
provider results, never cookies or a general HTTP proxy.

Install the paired userscript, then open a repository page in Bitbucket and click **Open VS Code**. Keep that
tab open while working. If it closes or the session expires, reopen the repository in Bitbucket and launch a
fresh workbench from the userscript.

The workbench host must load the paired `bitbucket-datacenter-workbench-relay.js` release artifact in its
top-level HTML before bootstrapping VS Code so the extension-host worker can reach the opener channel.

Branch and pull-request actions use the current Data Center session. File commits are intentionally blocked by
the immutable `BLOCK_FILE_WRITES` constant in the userscript until the target installation proves atomic
stale-parent rejection.
