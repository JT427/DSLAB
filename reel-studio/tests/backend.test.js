'use strict';
// Run with: npm test   (uses Node's built-in test runner)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-test-'));
delete process.env.MUAPI_KEY;
const { server } = require('../server/server.js');
const DS = globalThis.DS;

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(async () => { await new Promise((r) => setTimeout(r, 400)); server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('data structures (DSLAB ports)', () => {
  assert.strictEqual(DS.evaluate('2*1.5+.5'), 3.5);
  assert.strictEqual(DS.evaluate('(4-1)*2^2'), 12);
  assert.ok(Number.isNaN(DS.evaluate('3+')));
  const arr = [5, 3, 9, 1, 7, 2], k = (x) => x, sorted = '1,2,3,5,7,9';
  for (const f of [DS.insertionSort, DS.quickSort, DS.mergeSort, DS.heapSort]) assert.strictEqual(f(arr, k).join(), sorted);
  const t = new DS.Timeline(); ['a', 'b', 'c', 'd'].forEach((id) => t.insertEnd({ id }));
  t.moveTo('d', 0); t.moveTo('a', 3); t.deletion('b');
  assert.strictEqual(t.display().map((x) => x.id).join(''), 'dca');
  assert.strictEqual(t.tail.prev.info.id, 'c');
  assert.strictEqual(DS.binarySearchStart([0, 2, 5, 9], 5.5), 2);
  const h = new DS.History(); h.record(1); h.record(2);
  assert.strictEqual(h.undo(3), 2); assert.strictEqual(h.redo(2), 3);
  const q = new DS.Queue(); q.enqueue(1); q.enqueue(2); assert.strictEqual(q.dequeue(), 1);
});

test('media upload, range streaming, sort, delete', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(base + '/api/media', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Filename': 'beach%20sunset.png', 'X-Width': '1', 'X-Height': '1' }, body: png });
  assert.strictEqual(up.status, 201);
  const item = await up.json();
  assert.strictEqual(item.kind, 'image'); assert.strictEqual(item.name, 'beach sunset');
  const r = await fetch(base + '/media/' + item.file, { headers: { Range: 'bytes=0-3' } });
  assert.strictEqual(r.status, 206); assert.strictEqual((await r.arrayBuffer()).byteLength, 4);
  const bad = await fetch(base + '/api/media', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.strictEqual(bad.status, 415);
  const list = await (await fetch(base + '/api/media?q=beach&sort=name')).json();
  assert.strictEqual(list.length, 1);
  const auto = await (await fetch(base + '/api/autoreel', { method: 'POST', body: '{"mode":"dfs"}' })).json();
  assert.deepStrictEqual(auto.order, [item.id]);
  assert.strictEqual((await fetch(base + '/api/media/' + item.id, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await (await fetch(base + '/api/media')).json()).length, 0);
});

test('projects round-trip', async () => {
  const p = await (await fetch(base + '/api/projects', { method: 'POST', body: '{"name":"Trip"}' })).json();
  p.clips = [{ id: 'c1', kind: 'title', duration: 2 }, { id: 'c2', kind: 'title', duration: 3 }];
  assert.strictEqual((await fetch(base + '/api/projects/' + p.id, { method: 'PUT', body: JSON.stringify(p) })).status, 200);
  const back = await (await fetch(base + '/api/projects/' + p.id)).json();
  assert.deepStrictEqual(back.clips.map((c) => c.id), ['c1', 'c2']);
  assert.strictEqual((await fetch(base + '/api/projects/..%2Fsettings')).status, 400);
});

test('hashtags, eval, AI guard, path traversal', async () => {
  const tags = await (await fetch(base + '/api/hashtags?q=%23tra')).json();
  assert.deepStrictEqual(tags, ['#transition', '#travel', '#travelgram']);
  assert.strictEqual((await (await fetch(base + '/api/eval?expr=' + encodeURIComponent('(1+2)*3'))).json()).value, 9);
  assert.strictEqual((await fetch(base + '/api/generate', { method: 'POST', body: '{"type":"image","prompt":"x"}' })).status, 400);
  assert.notStrictEqual((await fetch(base + '/media/..%2F..%2Fpackage.json')).status, 200);
  assert.strictEqual((await fetch(base + '/')).status, 200);
});
