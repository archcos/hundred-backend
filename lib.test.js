import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLetter, validateReply, boundsFilter, wrapLng, isUuid, autoFlags, blockedPattern, normalize } from './lib.js';

test('autoFlags', () => {
  const f = t => autoFlags(t);
  assert.deepEqual(f('Paris in the rain is still Paris.'), { flags: [], held: false });
  assert.deepEqual(f('We met in 2019 and 2020, 3 times.').flags, []); // years are not phone numbers
  assert.deepEqual(f('call me 0917 123 4567'), { flags: ['personal-info'], held: true });
  assert.deepEqual(f('mail me: someone@example.org').flags, ['personal-info']);
  assert.ok(f('<script>alert(1)</script>').held);
  assert.ok(f('<img src=x onerror=alert(1)>').flags.includes('code'));
  assert.deepEqual(f('visit mysite dot com').flags, ['hidden-link']);
  assert.ok(f('go to site[.]xyz').held);
  assert.ok(f('h̸̡̛e̷̛͓l̴̢̛l̵̡̛ơ̸̢ w̵̢̛ơ̴̢r̸̢̛l̷̢̛d̵̢̛').held); // zalgo
  // Other scripts are normal letters, not "garbled": Arabic with vowel marks, Hindi, Thai, Japanese, Korean.
  for (const ok of ['السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللَّهِ وَبَرَكَاتُهُ، أحبُّ هذا المكانَ كثيرًا', 'मुझे यह जगह बहुत पसंद है, मैं यहाँ फिर आऊँगा। धन्यवाद दोस्तों',
    'ฉันรักสถานที่แห่งนี้มาก ขอบคุณสำหรับทุกอย่างที่ผ่านมา', 'この場所が大好きです。ありがとう、また来ます。がんばって！', '이곳이 정말 좋아요. 다시 올게요, 고마워요']) {
    assert.deepEqual(f(ok), { flags: [], held: false }, `wrongly flagged: ${ok.slice(0, 20)}`);
  }
  assert.deepEqual(f('I will kill you'), { flags: ['threat'], held: false });
  assert.deepEqual(f('some days I want to die').flags, ['self-harm']);
  assert.deepEqual(f('BUY NOW THIS IS THE BEST DEAL EVER').flags, ['spam']);
  assert.deepEqual(f('aaaaaaaaaaaaaaa').flags, ['spam']);
  assert.deepEqual(f('free free free free free').flags, ['spam']);
});
import { randomUUID } from 'node:crypto';
import { DEFAULT_BLOCKED_WORDS } from './blocklist.js';

test('isUuid', () => {
  assert.ok(isUuid(randomUUID()));
  assert.ok(isUuid('3F2504E0-4F89-11D3-9A0C-0305E82C3301'));
  for (const bad of ['21', '', null, 7, 'not-a-uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c330', "x' OR 1=1 --"]) assert.equal(isUuid(bad), false);
});

test('letter style + replies', () => {
  const ok = validateLetter({ body: 'hi', lat: 0, lng: 0, font: 'type', paper: 'airmail' }).letter;
  assert.equal(ok.font, 'type'); assert.equal(ok.paper, 'airmail');
  const fallback = validateLetter({ body: 'hi', lat: 0, lng: 0, font: '<script>', paper: 'x' }).letter;
  assert.equal(fallback.font, 'hand'); assert.equal(fallback.paper, 'cream');
  assert.equal(validateReply({ body: 'thank you' }).reply.body, 'thank you');
  assert.ok(validateReply({ body: 'x'.repeat(301) }).error);
  assert.ok(validateReply({ body: 'www.spam.com' }).error);
  assert.ok(validateReply({ body: '' }).error);
  const cheap = blockedPattern(['cheap']);
  assert.ok(validateReply({ body: 'buy CHEAP pills' }, cheap).error);
  assert.ok(validateLetter({ body: 'hi', name: 'Mr Cheap', lat: 0, lng: 0 }, cheap).error);
  assert.ok(validateLetter({ body: 'hi', lat: 0, lng: 0 }, cheap).letter);
  assert.ok(validateLetter({ body: 'hi', lat: 0, lng: 0 }, null).letter);
});

test('blockedPattern: whole words, disguises, no false positives', () => {
  const re = blockedPattern(['retard', 'ass', 'free bitcoin', 'Spam']);
  const hit = t => re.test(normalize(t));
  for (const t of ['you RETARD', 'retards', 'retarded', 'r3tard', 'r e t a r d', 'r.e.t.a.r.d', 'reeetard', 'rétard',
    'r​etard', 'ass', 'FREE   bitcoin!!', 'free-bitcoin', 'free bit coin', 'spams', 'SPAM']) assert.ok(hit(t), `should block: ${t}`);
  for (const t of ['flame retardant', 'class', 'passion', 'assassin', 'bass guitar', 'a freebie', 'Spamalot musical'])
    assert.ok(!hit(t), `should allow: ${t}`);
  // The real starter list must not block ordinary letters.
  const starter = blockedPattern(DEFAULT_BLOCKED_WORDS);
  const ok = ['I love spicy food and all the spices', 'Love, Mum xxx', 'a honky-tonk piano', 'we played japes on each other',
    'the raccoon ate my snacks', 'class of 2019, passion, assassin', 'flame retardant paint', 'my grandfather from Japan',
    'he did a pic of the spice market', 'Paris in the rain', 'whatsapp me when you land', 'the cocktail was great',
    'Scunthorpe and Penistone are towns', 'the fagot is a bassoon in Italian? no, fagotto'];
  for (const t of ok) assert.ok(!starter.test(normalize(t)), `starter list wrongly blocks: ${t}`);
  for (const t of ['you are a r3tard', 'send nudes', 'FREE  BITCOIN', 'k y s', 'heil hitler']) assert.ok(starter.test(normalize(t)), `starter list misses: ${t}`);
  assert.equal(blockedPattern([]), null);
  assert.equal(blockedPattern(['  ', '']), null);
});

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
