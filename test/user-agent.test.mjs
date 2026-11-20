/**
 * Every API call names this connector in its User-Agent, so the CourtMesh
 * access audit can show a call as made through the MCP connector rather than
 * directly with the key. A display hint only: the API never trusts it for access.
 *
 * Run: npm test   (build first, this drives dist/client.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request, CLIENT_USER_AGENT } from '../dist/client.js';
import { SERVER_VERSION } from '../dist/version.js';

test('API calls carry the connector name and version as the User-Agent', async () => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = req.headers['user-agent'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: {} }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    await request({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', path: '/health' });
    assert.equal(CLIENT_USER_AGENT, `courtmesh-mcp/${SERVER_VERSION}`);
    assert.equal(seen, CLIENT_USER_AGENT);
  } finally {
    server.close();
  }
});
