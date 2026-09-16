const express = require('express');
const http = require('http');
const { Readable } = require('stream');

function makeTestApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
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
    const res = new http.ServerResponse(req);
    const chunks = [];

    res.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    res.end = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: res.statusCode,
        body: text ? JSON.parse(text) : null,
        headers: res.getHeaders(),
      });
    };

    app.handle(req, res, reject);
  });
}

module.exports = { makeTestApp, request };
