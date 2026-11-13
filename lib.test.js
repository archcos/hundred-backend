import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLetter, boundsFilter, wrapLng } from './lib.js';

test('validateLetter', () => {
  assert.ok(validateLetter({ body: 'hi', lat: 10, lng: 20 }).letter);
  assert.equal(validateLetter({ body: '  ', lat: 0, lng: 0 }).error, 'Write something first.');
  assert.ok(validateLetter({ body: 'x'.repeat(501), lat: 0, lng: 0 }).error);
  assert.ok(validateLetter({ body: 'go to example.com', lat: 0, lng: 0 }).error);
  assert.ok(validateLetter({ body: 'see https://x', lat: 0, lng: 0 }).error);
  assert.ok(validateLetter({ body: 'hi', lat: 95, lng: 0 }).error);
  assert.ok(validateLetter({ body: 'hi', lat: 'abc', lng: 0 }).error);
  assert.equal(validateLetter({ body: 'hi', lat: 0, lng: 190 }).letter.lng, -170);
});

test('wrapLng / boundsFilter', () => {
  assert.equal(wrapLng(-190), 170);
  assert.equal(wrapLng(45), 45);
  assert.equal(boundsFilter({}).sql, '1=1');
  assert.deepEqual(boundsFilter({ w: -400, s: -80, e: 400, n: 80 }).params, [-80, 80]);
  assert.match(boundsFilter({ w: 10, s: 0, e: 20, n: 5 }).sql, /BETWEEN \? AND \?$/);
  assert.match(boundsFilter({ w: 170, s: 0, e: 190, n: 5 }).sql, /OR/); // crosses 180°
});
