// 假服务集合，供 UI 试验台使用。常驻进程（被 detached 拉起），所以不会随试验台脚本退出。
//   8097 -> HTTP 200（健康，绿灯）
//   8098 -> HTTP 500（在听但不健康，琥珀灯）
//   8099 -> 不监听（离线，灯灭）
'use strict';
const http = require('node:http');

function serve(port, status) {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: status === 200, status }));
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200 }));
  }).listen(port, '127.0.0.1', () => console.log('fake on ' + port + ' -> ' + status));
}

serve(8097, 200);
serve(8098, 500);
// 8099 故意不监听
