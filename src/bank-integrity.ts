import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { BankInfo } from './types.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function describe(bytes: Uint8Array): BankInfo {
  const manifest = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const detector = record(record(manifest.files)['shared_detector.bin']);
  if (manifest.schema !== 'lmfpd-data-v1' || manifest.detector_schema !== 'shared-detector-v2' ||
      typeof manifest.built_at !== 'string' || !Number.isFinite(Date.parse(manifest.built_at)) ||
      !Array.isArray(manifest.models) ||
      typeof detector.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(detector.sha256)) {
    throw new Error('Invalid detector manifest');
  }
  return { builtAt: manifest.built_at, modelCount: manifest.models.length, sha256: detector.sha256.toLowerCase() };
}

export async function fetchBankInfo(source: string): Promise<BankInfo> {
  const response = await fetch(new URL('bundle.json', source), {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Detector manifest request failed (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new Error('Detector manifest exceeds size limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return describe(Buffer.concat(chunks, size));
}

async function readExactly(file: FileHandle, length: number) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const part = await file.read(bytes, offset, length - offset, null);
    if (part.bytesRead === 0) throw new Error('Incomplete detector cache header');
    offset += part.bytesRead;
  }
  return bytes;
}

export async function verifyCache(path: string, expected?: BankInfo): Promise<BankInfo> {
  const file = await open(path, 'r');
  try {
    // The SDK stores a four-byte manifest length, UTF-8 JSON and the raw detector payload.
    const length = (await readExactly(file, 4)).readUInt32LE();
    if (length > MAX_MANIFEST_BYTES) throw new Error('Detector manifest exceeds size limit');
    const info = describe(await readExactly(file, length));
    if (expected && (expected.sha256 !== info.sha256 || expected.builtAt !== info.builtAt ||
        expected.modelCount !== info.modelCount)) {
      throw new Error('Detector manifest changed during download');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (hash.digest('hex') !== info.sha256) throw new Error('Detector checksum mismatch');
    return info;
  } finally {
    await file.close();
  }
}
