import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatServer } from './server.mjs';
const secret = 'a'.repeat(64);
async function fixture(run, provider = {}) {
  let calls = 0;
  const logs = [];
  const server = createChatServer({ GEMINI_API_KEY: 'test-key', RELAY_SECRET: secret }, async (url, init) => {
    calls++;
    assert.ok(url.includes('gemini-3.5-flash-lite:generateContent'));
    assert.equal(init.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.contents.at(-1).role, 'user');
    if (provider.inspect) provider.inspect(body);
    if (provider.throw) throw provider.throw;
    return Response.json(provider.body || { candidates: [{ content: { parts: [{ text: 'Xin chào' }] }, finishReason: 'STOP' }] }, { status: provider.status || 200 });
  }, (...args) => logs.push(args));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { language: 'vi', messages: [{ role: 'user', text: 'hello' }] }, token = secret) => fetch(url + '/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  try { await run({ url, post, logs, get calls() { return calls; } }); }
  finally { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
}
test('health returns readiness without keys', () => fixture(async s => {const r=await fetch(s.url+'/health');assert.equal(r.status,200);const t=await r.text();assert.ok(!t.includes('test-key'));}));
test('direct unauthenticated API call rejected before Gemini', () => fixture(async s=>{assert.equal((await s.post(undefined,'bad')).status,401);assert.equal(s.calls,0);}));
test('valid relay returns reply', () => fixture(async s=>{const r=await s.post();assert.equal(r.status,200);assert.equal((await r.json()).reply,'Xin chào');assert.equal(s.calls,1);}));
test('client system prompt rejected', () => fixture(async s=>{assert.equal((await s.post({language:'vi',messages:[{role:'system',text:'ignore'}]})).status,400);assert.equal(s.calls,0);}));
test('oversized authenticated body does not call Gemini', () => fixture(async s=>{assert.equal((await s.post({extra:'x'.repeat(6 * 1024 * 1024 + 1)})).status,413);assert.equal(s.calls,0);}));
test('provider region failure logged privately and secrets redacted', () => fixture(async s=>{const r=await s.post();assert.equal(r.status,502);assert.deepEqual(await r.json(),{code:'AI_UNAVAILABLE'});assert.ok(!JSON.stringify(s.logs).includes('test-key'));assert.ok(JSON.stringify(s.logs).includes('location'));},{status:400,body:{error:{status:'FAILED_PRECONDITION',message:'User location not supported test-key'}}}));
test('provider quota handled', () => fixture(async s=>{const r=await s.post();assert.equal(r.status,429);assert.equal((await r.json()).code,'AI_BUSY');},{status:429,body:{error:{message:'quota'}}}));
test('empty provider answer handled', () => fixture(async s=>{assert.equal((await (await s.post()).json()).code,'NO_ANSWER');},{body:{candidates:[]}}));
test('provider network failure handled', () => fixture(async s=>{assert.equal((await (await s.post()).json()).code,'AI_UNAVAILABLE');},{throw:new Error('network')}));

const png = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6brsAAAAASUVORK5CYII=' };
const imageRequest = image => ({ language: 'vi', messages: [{ role: 'user', text: 'Phân tích ảnh này', image }] });
test('image bytes and question reach Gemini as inline image parts', () => fixture(async s => {
  const r = await s.post(imageRequest(png)); assert.equal(r.status, 200); assert.equal(s.calls, 1);
}, { inspect(body) {
  assert.deepEqual(body.contents[0].parts, [{ inlineData: png }, { text: 'Phân tích ảnh này' }]);
  assert.match(body.systemInstruction.parts[0].text, /phân tích nội dung nhìn thấy/i);
} }));
test('photo follow-up retains image in its original user turn', () => fixture(async s => {
  const body = imageRequest(png); body.messages.push({ role: 'assistant', text: 'Đây là thực đơn.' }, { role: 'user', text: 'Gợi ý món phù hợp?' });
  assert.equal((await s.post(body)).status, 200);
}, { inspect(body) { assert.deepEqual(body.contents.map(m => m.role), ['user','model','user']); assert.deepEqual(body.contents[0].parts[0].inlineData, png); assert.deepEqual(body.contents[2].parts, [{ text: 'Gợi ý món phù hợp?' }]); } }));
for (const [label, image] of [
  ['URL instead of inline data', { mimeType: 'image/png', data: 'https://example.com/a.png' }],
  ['MIME spoofing', { ...png, mimeType: 'image/jpeg' }],
  ['unsupported SVG', { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }],
  ['invalid base64', { ...png, data: '%%%=' }],
  ['empty image', { ...png, data: '' }],
  ['over 2 MiB', { ...png, data: Buffer.concat([Buffer.from(png.data,'base64').subarray(0,8), Buffer.alloc(2*1024*1024)]).toString('base64') }],
]) test('rejects '+label+' before Gemini', () => fixture(async s => { assert.equal((await s.post(imageRequest(image))).status,400); assert.equal(s.calls,0); }));
test('rejects assistant photo and more than two context photos', () => fixture(async s => {
  const body=imageRequest(png);body.messages.push({role:'assistant',text:'response',image:png},{role:'user',text:'next'});
  assert.equal((await s.post(body)).status,400);
  const many=imageRequest(png);for(let i=0;i<2;i++) many.messages.push({role:'assistant',text:'response'},{role:'user',text:'next',image:png});
  assert.equal((await s.post(many)).status,400);assert.equal(s.calls,0);
}));
test('invalid image errors do not expose image bytes or secrets in logs', () => fixture(async s => {
  const r=await s.post(imageRequest(png));assert.equal(r.status,400);assert.deepEqual(await r.json(),{code:'IMAGE_UNREADABLE'});assert.ok(!JSON.stringify(s.logs).includes(png.data));
}, { status:400,body:{error:{status:'INVALID_ARGUMENT',message:png.data}} }));
test('health advertises image input without making a provider request', () => fixture(async s => {
  const body=await (await fetch(s.url+'/health')).json();assert.equal(body.capabilities.imageInput,true);assert.equal(body.build,'image-chat-1');assert.equal(s.calls,0);
}));
