import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../index.js';

test('greet returns hello', () => {
  assert.equal(greet(), 'hello');
});
