import { createServer } from 'node:http';

const server = createServer((req, res) => {
  if (req.url === '/livez') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ALIVE',
      mode: process.env.MLG_RUNTIME_DISABLED === 'true' ? 'disabled' : 'minicamp',
    }));
    return;
  }

  if (process.env.MLG_RUNTIME_DISABLED === 'true') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'DISABLED', reason: 'Runtime intentionally disabled' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'HTTP_HEALTH_SERVER_READY', port }));
});

if (process.env.MLG_RUNTIME_DISABLED !== 'true') {
  // Keep the worker on Render's web-service runtime while exposing a minimal
  // liveness endpoint. The bot itself does not serve public HTTP requests.
  await import('./minicamp-worker.ts');
} else {
  console.log(JSON.stringify({ event: 'RUNTIME_DISABLED', at: new Date().toISOString() }));
}

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
