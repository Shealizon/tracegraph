import { writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) { return new Promise((res, rej) => { const id = ++idc; const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } }; ws.addEventListener('message', on); const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl)); }); }
const ev = (e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);
const shot = async (f) => { const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(s.data, 'base64')); console.log('shot', f); };
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true }); SESSION = att.sessionId;
await rpc(ws, 'Runtime.enable'); await rpc(ws, 'Page.enable'); await sleep(2500);
// 点击「新建项目」
await ev(`document.querySelector('[data-create]').click()`);
await sleep(1200);
const info = await ev(`(()=>{const inp=document.querySelector('.project-dialog [data-name]');const add=document.querySelectorAll('.project-dialog [data-add]');return JSON.stringify({nameValue:inp&&inp.value,placeholder:inp&&inp.placeholder,addBtnCount:add.length,addTitle:add[0]&&add[0].title});})()`);
console.log('dialog', info);
await shot('C:/temp/verify-dialog.png');
ws.close();
