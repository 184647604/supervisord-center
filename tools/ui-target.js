// 试验台里「能被真正启动」的目标：监听指定端口，收到请求就答。
// 用来验证「启动成功 → 显示绿色成功提示」这条路径。
// 用法: node tools/ui-target.js <port>
'use strict';
const http = require('node:http');
const port = Number(process.argv[2] || 8099);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, port }));
}).listen(port, '127.0.0.1', () => console.log('target on ' + port));
