// 假被托管服务：监听 argv[2] 端口，收到请求就回一行字。
// 只用于验证 supervisord-center 的 /start 与 /restart（尤其是 kill → 重启
// 这条路径），绝不碰真实的 DSH。
const http = require('node:http');
const port = Number(process.argv[2] || 8099);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('dummy pid=' + process.pid + ' port=' + port + '\n');
});
server.listen(port, '127.0.0.1', () => {
  console.log('dummy listening on ' + port + ' pid=' + process.pid);
});
