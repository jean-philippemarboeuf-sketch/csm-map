const http = require('http');
const https = require('https');

const HS_TOKEN = process.env.HS_TOKEN || '';
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve the map HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const fs = require('fs');
    const html = fs.readFileSync('./index.html', 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Proxy HubSpot API
  if (url.pathname.startsWith('/hs/')) {
    const hspath = url.pathname.replace('/hs', '') + url.search;
    let body = '';

    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const options = {
        hostname: 'api.hubapi.com',
        path: hspath,
        method: req.method,
        headers: {
          'Authorization': `Bearer ${HS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      };

      const proxy = https.request(options, (hsRes) => {
        let data = '';
        hsRes.on('data', chunk => { data += chunk; });
        hsRes.on('end', () => {
          res.writeHead(hsRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      proxy.on('error', (e) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });

      if (body) proxy.write(body);
      proxy.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`CSM Map server running on port ${PORT}`);
});
