const express = require('express');
const http = require('http');

function makeTestApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  return app;
}

/** Serves `app` on an ephemeral local port for one call and returns its JSON reply. */
async function request(app, path, options = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body || undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: Object.fromEntries(response.headers),
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** `request` with the JSON content headers express.json() needs for a body. */
function jsonRequest(app, path, options = {}) {
  const headers = options.body
    ? {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(options.body)),
        ...options.headers,
      }
    : options.headers;
  return request(app, path, { ...options, headers });
}

module.exports = { makeTestApp, request, jsonRequest };
