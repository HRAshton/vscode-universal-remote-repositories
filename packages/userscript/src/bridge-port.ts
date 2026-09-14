export function disconnectBridgePort(port: MessagePort | undefined): void {
  if (!port) return;
  port.postMessage({ type: 'disconnect' });
  port.close();
}
