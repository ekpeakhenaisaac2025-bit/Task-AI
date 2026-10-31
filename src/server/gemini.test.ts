import test from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingLevel } from '@google/genai';
import {
  formatGeminiApiError,
  getResilientFlashAttemptSpecs,
} from './gemini.ts';

test('getResilientFlashAttemptSpecs never passes ThinkingLevel.MINIMAL to gemini-3.8-flash', () => {
  const specs = getResilientFlashAttemptSpecs();
  assert.ok(specs.length >= 2);
  assert.equal(specs[0].model, 'gemini-3.8-flash');
  assert.equal(specs[0].thinkingLevel, ThinkingLevel.LOW);

  for (const spec of specs) {
    if (spec.model === 'gemini-3.8-flash') {
      assert.notEqual(
        spec.thinkingLevel,
        ThinkingLevel.MINIMAL,
        'gemini-3.8-flash rejects ThinkingLevel.MINIMAL with HTTP 400'
      );
    }
  }
});

test('formatGeminiApiError maps key and quota errors to Settings > Secrets guidance', () => {
  const invalidKeyErr = formatGeminiApiError(
    new Error('400 API_KEY_INVALID: API key not valid.')
  );
  assert.match(invalidKeyErr.message, /Settings > Secrets/);

  const forbiddenErr = formatGeminiApiError(
    new Error('403 PERMISSION_DENIED: caller does not have permission')
  );
  assert.match(forbiddenErr.message, /Settings > Secrets/);

  const quotaErr = formatGeminiApiError(
    new Error('429 RESOURCE_EXHAUSTED: Quota exceeded')
  );
  assert.match(quotaErr.message, /429 RESOURCE_EXHAUSTED/);
  assert.match(quotaErr.message, /Settings > Secrets/);
});
