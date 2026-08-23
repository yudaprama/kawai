/** Base64 ↔ bytes helpers — single implementation for the frontend. */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64ToText(b64: string): string {
  return new TextDecoder("utf-8").decode(base64ToBytes(b64));
}

export function dataUrlToFile(dataUrl: string, name: string): File {
  const [meta, b64] = dataUrl.split(",", 2);
  const mime = meta.slice(5, meta.indexOf(";")) || "application/octet-stream";
  return new File([base64ToBytes(b64 ?? "") as unknown as BlobPart], name, { type: mime });
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer)) {
        reject(new Error("Unexpected file read result"));
        return;
      }
      resolve(bytesToBase64(new Uint8Array(result)));
    };
    reader.readAsArrayBuffer(file);
  });
}
