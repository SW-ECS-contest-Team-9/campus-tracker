// F11 지금 열려 있는 쪽에서 식 하나를 돌려 본다(읽기용).  node eval.mjs <파일.js> [--chrome=9341]
import fs from 'node:fs';
const args = process.argv.slice(2), CHROME = (args.find((a) => a.startsWith('--chrome=')) ?? '--chrome=9341').split('=')[1];
const list = await (await fetch(`http://127.0.0.1:${CHROME}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) { console.log(JSON.stringify(msg.result.exceptionDetails ?? msg.result.result.value, null, 1)); ws.close(); } };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { ${fs.readFileSync(args[0], 'utf8')} })()`, awaitPromise: true, returnByValue: true } }));
