import { createBridgeLaunch, relayBitbucketDataCenterBridge } from '@remote/bitbucket-datacenter-adapter';

const launch = createBridgeLaunch(new URL(globalThis.location.href));
if (launch && window.opener) {
  const dispose = relayBitbucketDataCenterBridge(launch, window.opener);
  window.addEventListener('pagehide', dispose, { once: true });
}
