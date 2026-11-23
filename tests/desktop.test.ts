import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Detector, Output } from 'lmfpd-sdk';
import { emptySnapshot } from './bank-snapshot.js';
import { ReferenceBank } from '../src/bank.js';
import { verifyCache } from '../src/bank-integrity.js';
import { accountMode, chooseRoute, sameAccount, type ReadyCodex } from '../src/codex.js';
import { savedLoginEnvironment } from '../src/codex-process.js';
import { finishDetection, makeDetection, sampleArgs, textOnlyModel, type CollectOptions } from '../src/collect.js';
import type { ModelChoice } from '../src/types.js';

const gateway = {
  defaultProviderId: 'gateway',
  data: [{ id: 'gateway', baseUrl: 'https://gateway.example.test/v1', settings: { type: 'customGateway', auth: { mode: 'externallyConfigured', envKey: null } } }],
};
const official = {
  defaultProviderId: 'openai',
  data: [{ id: 'openai', baseUrl: null, settings: { type: 'openai' } }],
};
const model: ModelChoice = { id: 'gpt-test', title: 'GPT Test', effort: 'low', isDefault: true };

function readyFrom(account: 'apiKey' | 'chatgpt'): ReadyCodex {
  const { route, config } = chooseRoute(account, gateway, official, account === 'apiKey');
  return {
    executable: 'codex.exe', routeConfig: config, bundled: new Map(),
    connection: { state: 'ready', account, version: '0.171.0', configuredProvider: 'gateway', route, models: [model], message: null },
  };
}

test('ChatGPT keeps the official endpoint and rejects an unconfirmed provider override', () => {
  const ready = readyFrom('chatgpt');
  assert.deepEqual(ready.connection.route, { kind: 'chatgpt', origin: 'https://chatgpt.com', provider: 'openai' });
  assert.equal(ready.routeConfig.openai_base_url, 'https://chatgpt.com/backend-api/codex');
  assert.throws(() => chooseRoute('chatgpt', gateway, gateway, true), /官方 ChatGPT 通道未验证/);
  assert.throws(() => chooseRoute('chatgpt', gateway, { ...official, data: [{ ...official.data[0], baseUrl: 'https://gateway.example.test' }] }, true), /官方 ChatGPT 通道未验证/);
});

test('API Key preserves the configured Responses path and rejects unprojectable gateway auth', () => {
  const ready = readyFrom('apiKey');
  assert.equal(ready.connection.route.kind, 'custom');
  assert.equal(ready.routeConfig['model_providers.gateway.base_url'], 'https://gateway.example.test/v1');
  assert.equal(ready.routeConfig['model_providers.gateway.requires_openai_auth'], true);
  assert.equal(ready.routeConfig['model_providers.gateway.request_max_retries'], 0);
  assert.equal(ready.routeConfig['model_providers.gateway.stream_max_retries'], 0);
  assert.throws(() => chooseRoute('apiKey', gateway, official, false));
  assert.throws(() => chooseRoute('signedOut', gateway, official, false));
  assert.throws(() => chooseRoute('apiKey', {
    ...gateway, data: [{ ...gateway.data[0], baseUrl: 'https://gateway.example.test/v1?credential=fixture' }],
  }, official, true));
});

test('credential mode and account identity checks use public metadata', () => {
  assert.equal(accountMode({ account: null }), 'signedOut');
  assert.equal(accountMode({ account: { type: 'gcp' } }), 'other');
  const chatgpt = { account: { type: 'chatgpt', workspaceName: 'Personal' }, userId: 'public-test-id' };
  assert(sameAccount(chatgpt, structuredClone(chatgpt)));
  assert(!sameAccount(chatgpt, { ...chatgpt, userId: 'another-test-id' }));
  assert(!sameAccount(chatgpt, { account: { type: 'apiKey' } }));
  const env = savedLoginEnvironment({ Path: 'test-path', CODEX_HOME: 'test-directory', Codex_Api_Key: 'fixture', OPENAI_API_KEY: 'fixture', CODEX_ACCESS_TOKEN: 'fixture' });
  const pass: Record<string, unknown> = {};
  for (const key in env) pass[key] = env[key];
  assert.deepEqual(pass, { Path: 'test-path', CODEX_HOME: 'test-directory' });
});

test('sampling launches isolated text turns with distinct exact SDK challenges', () => {
  const ready = readyFrom('apiKey');
  const run = makeDetection(ready, model);
  const args = sampleArgs(ready, model, 'C:/test/models.json');
  assert.equal(new Set(run.samples.map((s) => s.expected)).size, 3);
  assert(run.samples.every((s) => s.expected >= 292 && s.expected <= 332 && s.prompt.includes(String(s.expected))));
  assert(run.samples.every((s) => !args.includes(s.prompt)));
  for (const expected of ['--ignore-user-config', '--ephemeral', 'features.shell_tool=false', 'features.plugins=false', 'web_search="disabled"', 'model_catalog_json="C:/test/models.json"', 'features.goals=false']) {
    assert(args.includes(expected), expected);
  }
  assert.equal(args.at(-1), '-');
});

test('model-supplied tools and instructions are removed without changing the requested model or transport', () => {
  const model = {
    slug: 'gpt-test', base_instructions: 'fixture', model_messages: { template: 'fixture' },
    use_responses_lite: true, tool_mode: 'code_mode_only', shell_type: 'unified_exec',
    apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], supports_parallel_tool_calls: true,
  };
  assert.deepEqual(textOnlyModel(model), {
    slug: 'gpt-test', base_instructions: '', model_messages: null, use_responses_lite: true,
    tool_mode: 'direct', shell_type: 'disabled', apply_patch_tool_type: null,
    experimental_supported_tools: [], supports_parallel_tool_calls: false,
  });
  assert.equal(model.tool_mode, 'code_mode_only');
});

test('partial scoring sees original received text, cancellation preserves evidence', () => {
  const run = makeDetection(readyFrom('apiKey'), model);
  const answer = '12, 63, 77\n';
  Object.assign(run.samples[0], { status: 'received', raw: answer, count: 3 });
  Object.assign(run.samples[1], { status: 'failed', raw: '2', count: 1 });
  Object.assign(run.samples[2], { status: 'timeout' });
  const controller = new AbortController();
  const calls: Output[][] = [];
  const reference = {
    info: { builtAt: 'fixture', sha256: 'fixture', modelCount: 0 },
    detector: { analyze: (outputs: Output[]) => { calls.push(outputs); return { decision: 'unscorable', results: [] }; } } as unknown as Detector,
  };
  const options: CollectOptions = { signal: controller.signal, update: () => {}, bank: () => reference };
  finishDetection(run, options, reference);
  assert.deepEqual(calls, [[{ text: answer, expected_count: run.samples[0].expected }]]);
  assert.equal(run.status, 'unscorable');
  assert.equal(run.samples[1].raw, '2');

  const cancelled = makeDetection(readyFrom('apiKey'), model);
  cancelled.samples[0] = { ...run.samples[0] };
  controller.abort();
  finishDetection(cancelled, options, reference);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.analysis, null);
  assert.equal(cancelled.samples[0].raw, answer);
  assert.equal(calls.length, 1);
});

test('failed, timed out, and unavailable reference runs retain their distinct states', () => {
  const run = makeDetection(readyFrom('apiKey'), model);
  const options: CollectOptions = { signal: new AbortController().signal, update: () => {}, bank: () => null };
  run.samples[0].status = 'failed';
  finishDetection(run, options, null);
  assert.equal(run.status, 'failed');
  run.samples[1].status = 'timeout';
  finishDetection(run, options, null);
  assert.equal(run.status, 'timeout');
  run.samples[2].status = 'received';
  run.samples[2].raw = '29, 9';
  finishDetection(run, options, null);
  assert.equal(run.status, 'bankUnavailable');
  assert.equal(run.analysis, null);
  assert.equal(run.samples[2].raw, '29, 9');
});

test('cache verification rejects a malformed header, changed manifest or altered detector', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-bank-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'reference.bin');
  await writeFile(file, Buffer.from([255, 255, 255, 255]));
  await assert.rejects(verifyCache(file), /size limit/);
  await writeFile(file, Buffer.from([10, 0, 0, 0, 123]));
  await assert.rejects(verifyCache(file), /Incomplete/);
  const { cache, sha256, builtAt } = emptySnapshot();
  await writeFile(file, cache);
  assert.deepEqual(await verifyCache(file), { sha256, builtAt, modelCount: 0 });
  await assert.rejects(verifyCache(file, { sha256, builtAt, modelCount: 2 }), /changed/);
  cache[cache.length - 1] ^= 1;
  await writeFile(file, cache);
  await assert.rejects(verifyCache(file), /checksum mismatch/);
});

test('SDK updates install verified bytes, reject a corrupted replacement and reopen offline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-bank-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = emptySnapshot();
  const newer = emptySnapshot('2026-02-15T00:00:00Z');
  let manifest = first.manifest;
  let chunk = first.chunk;
  let online = true;
  t.mock.method(globalThis, 'fetch', async (resource: URL | string) => {
    if (!online) throw new Error('offline');
    if (String(resource).endsWith('/bundle.json')) return new Response(manifest);
    if (String(resource).endsWith('/chunks/empty.zst')) return new Response(Uint8Array.from(chunk));
    throw new Error('Unexpected request');
  });
  const bank = new ReferenceBank(dir, () => {});
  await bank.refresh();
  assert.equal(bank.state.state, 'ready');
  assert.equal(bank.state.info?.sha256, first.sha256);
  const cache = join(dir, 'reference.bin');
  assert.deepEqual(await readFile(cache), first.cache);
  // Advertise an incorrect checksum in the newer manifest. The decoded detector is
  // structurally valid, so this exercises our verification after the SDK loads it.
  manifest = newer.manifest.replace(newer.sha256, 'f'.repeat(64));
  chunk = newer.chunk;
  await bank.refresh();
  assert.equal(bank.state.info?.sha256, first.sha256);
  assert.deepEqual(await readFile(cache), first.cache);
  manifest = newer.manifest;
  await bank.refresh();
  assert.equal(bank.state.info?.sha256, newer.sha256);
  assert.deepEqual(await readFile(cache), newer.cache);
  online = false;
  const reopened = new ReferenceBank(dir, () => {});
  await reopened.refresh();
  assert.equal(reopened.state.state, 'ready');
  assert.equal(reopened.state.info?.sha256, newer.sha256);
  assert.ok(reopened.state.message);
});
