/**
 * Tests for computeIdempotencyKey's session scoping (src/tools.ts).
 *
 * The key used to be derived from the tool name and arguments alone, so two
 * unrelated callers who happened to send byte identical arguments within the
 * same 24 hour window would silently replay each other's cached result and
 * be told nothing beyond the ordinary "Replayed: ..." note. `sessionSalt` (a
 * per-process random value over stdio, the Mcp-Session-Id over Streamable
 * HTTP, see src/index.ts) scopes that key space to one session; `nonce`
 * (driven by the `fresh` tool argument) lets a caller deliberately force a
 * fresh key for otherwise identical arguments in the same session.
 *
 * Run: npm test   (build first, this drives dist/tools.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIdempotencyKey } from '../dist/tools.js';

const TOOL = 'analyze_case';
const ARGS = { id: 'abc123', force: false };

test('the same tool, arguments and session always derive the same key', () => {
  const a = computeIdempotencyKey(TOOL, ARGS, 'session-1');
  const b = computeIdempotencyKey(TOOL, ARGS, 'session-1');
  assert.equal(a, b);
});

test('the same tool and arguments derive different keys in different sessions', () => {
  const a = computeIdempotencyKey(TOOL, ARGS, 'session-1');
  const b = computeIdempotencyKey(TOOL, ARGS, 'session-2');
  assert.notEqual(a, b, 'two sessions must never replay each other');
});

test('argument order does not change the key within one session', () => {
  const a = computeIdempotencyKey(TOOL, { id: 'abc123', force: false }, 'session-1');
  const b = computeIdempotencyKey(TOOL, { force: false, id: 'abc123' }, 'session-1');
  assert.equal(a, b);
});

test('a different argument value derives a different key', () => {
  const a = computeIdempotencyKey(TOOL, { id: 'abc123', force: false }, 'session-1');
  const b = computeIdempotencyKey(TOOL, { id: 'abc123', force: true }, 'session-1');
  assert.notEqual(a, b);
});

test('a different tool name derives a different key for identical arguments and session', () => {
  const a = computeIdempotencyKey('analyze_case', ARGS, 'session-1');
  const b = computeIdempotencyKey('analyze_consolidated_case', ARGS, 'session-1');
  assert.notEqual(a, b);
});

test('a fresh nonce derives a different key than the plain call, same session and arguments', () => {
  const plain = computeIdempotencyKey(TOOL, ARGS, 'session-1');
  const fresh = computeIdempotencyKey(TOOL, ARGS, 'session-1', 'nonce-1');
  assert.notEqual(plain, fresh);
});

test('two fresh calls with different nonces derive different keys, even same session and arguments', () => {
  const a = computeIdempotencyKey(TOOL, ARGS, 'session-1', 'nonce-1');
  const b = computeIdempotencyKey(TOOL, ARGS, 'session-1', 'nonce-2');
  assert.notEqual(a, b, 'each fresh:true call must get its own key so it always bypasses the replay cache');
});

test('the key is a 64 character lowercase hex sha256 digest, within the Idempotency-Key charset', () => {
  const key = computeIdempotencyKey(TOOL, ARGS, 'session-1');
  assert.match(key, /^[0-9a-f]{64}$/);
});
