# Universal Remote Repositories for Bitbucket Data Center

This browser-only build reads Bitbucket Data Center repositories through the current same-origin browser
session. It is intentionally read-only. It must be hosted by the Code-OSS bootstrap on the same origin as
Bitbucket and built with the installation's `BITBUCKET_CONTEXT_PATH`.

The extension does not read, store, or forward session cookies. The browser attaches HttpOnly cookies only
to requests under the configured Bitbucket REST API path.
