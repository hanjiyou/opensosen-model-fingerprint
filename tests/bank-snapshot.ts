import { createHash } from 'node:crypto';

export function emptySnapshot(builtAt = '2026-01-15T00:00:00Z') {
  const metadata = Buffer.from(JSON.stringify({
    schema: 'shared-detector-v2', model_ids: [], response_counts: [], bank_built_at: builtAt,
  }));
  const payload = Buffer.alloc((metadata.length + 7) & ~3);
  payload.writeUInt32LE(metadata.length);
  metadata.copy(payload, 4);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const manifest = JSON.stringify({
    schema: 'lmfpd-data-v1', detector_schema: 'shared-detector-v2', models: [], built_at: builtAt,
    files: { 'shared_detector.bin': { parts: ['empty.zst'], sha256 } },
  });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(Buffer.byteLength(manifest));
  // A single raw Zstandard block lets the real SDK download the tiny detector
  // on every supported Node version, with no compression library in the tests.
  if (payload.length > 255) throw new Error('Fixture exceeds single-byte frame size');
  const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.length, 0, 0, 0]);
  frame.writeUIntLE((payload.length << 3) | 1, 6, 3);
  return {
    manifest, sha256, builtAt,
    cache: Buffer.concat([prefix, Buffer.from(manifest), payload]),
    chunk: Buffer.concat([frame, payload]),
  };
}
