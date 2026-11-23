import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATA_URLS, loadDetector, type Detector } from 'lmfpd-sdk';
import { fetchBankInfo, verifyCache } from './bank-integrity.js';
import type { BankInfo, BankState } from './types.js';

export class ReferenceBank {
  state: BankState = { state: 'checking', info: null, message: null };
  snapshot: { detector: Detector; info: BankInfo } | null = null;
  #refresh: Promise<void> | null = null;

  constructor(private readonly dir: string, private readonly emit: () => void) {}

  refresh() {
    if (this.#refresh) return this.#refresh;
    this.state = { state: 'checking', info: this.snapshot?.info ?? null, message: null };
    this.emit();
    this.#refresh = this.#load().finally(() => { this.#refresh = null; });
    return this.#refresh;
  }

  async #load() {
    const cache = join(this.dir, 'reference.bin');
    let installed = false;
    try {
      await mkdir(this.dir, { recursive: true });
      if (!this.snapshot) {
        try {
          const info = await verifyCache(cache);
          const detector = await loadDetector({ source: [], cache, ttl: Infinity });
          if (detector.builtAt !== info.builtAt) throw new Error('Cached detector changed during load');
          this.snapshot = { detector, info };
          this.state = { state: 'checking', info, message: null };
          this.emit();
        } catch {
          // Try the upstream sources if the local cache is absent or invalid.
        }
      }

      for (const source of DEFAULT_DATA_URLS) {
        const temporary = join(this.dir, `reference-${randomUUID()}.bin`);
        try {
          const remote = await fetchBankInfo(source);
          if (remote.sha256 !== this.snapshot?.info.sha256) {
            if (this.snapshot && Date.parse(remote.builtAt) < Date.parse(this.snapshot.info.builtAt)) continue;
            const detector = await loadDetector({ source, cache: temporary, ttl: Infinity });
            const info = await verifyCache(temporary, remote);
            if (detector.builtAt !== info.builtAt) throw new Error('Downloaded detector has a different snapshot date');
            await rename(temporary, cache);
            this.snapshot = { detector, info };
          }
          installed = true;
          break;
        } catch {
          // Continue with the next upstream mirror.
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
    } catch {
      // A local I/O failure must not suppress collected sample evidence.
    }
    this.state = this.snapshot
      ? { state: 'ready', info: this.snapshot.info, message: installed ? null : '更新未完成，正在使用已验证的缓存。' }
      : { state: 'unavailable', info: null, message: '参考库暂不可用。可以采集原始样本，等参考库可用后重新检测。' };
    this.emit();
  }
}
