// Tiny static file server for local testing: node serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const port = Number(process.argv[2]) || 8123;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`Serving on http://localhost:${port}`));
