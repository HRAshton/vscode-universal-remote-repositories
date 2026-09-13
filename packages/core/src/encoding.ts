export function encodeBase64(content: Uint8Array): string {
  let binary = '';
  for (const byte of content) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeBase64(content: string): Uint8Array {
  const binary = atob(content);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
