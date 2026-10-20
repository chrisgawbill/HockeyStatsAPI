const express = require('express');
const http = require('http');
const { Readable } = require('stream');

function makeTestApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  return app;
}

async function request(app, path, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || null;
  const req = new Readable({
    read() {
      if (body) {
        this.push(body);
      }
      this.push(null);
    },
  });
  req.url = path;
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );

  return await new Promise((resolve, reject) => {
    const response = new http.ServerResponse(req);
    const chunks = [];

    response.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    response.end = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: response.statusCode,
        body: text ? JSON.parse(text) : null,
        headers: response.getHeaders(),
      });
    };

    app.handle(req, response, reject);
  });
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
