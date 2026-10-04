import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const files = new Map([
    ['/', 'dev/preview.html'], ['/preview.js', 'dev/preview.js'],
    ...['index.js', 'core.js', 'styles.css', 'settings.html'].map(name => [`/scripts/extensions/third-party/prefill-extension/${name}`, name]),
]);
createServer(async (request, response) => {
    const file = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!file) { response.writeHead(404).end('Not found'); return; }
    try {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
        response.end(await readFile(new URL(file, root)));
    } catch { response.writeHead(500).end('Preview file unavailable'); }
}).listen(8787, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:8787'));
