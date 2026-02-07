#!/usr/bin/env node
/**
 * Lightweight HTTPS reverse-proxy for the Expo/Metro dev server.
 *
 * Safari requires a secure context (HTTPS) for navigator.mediaDevices.
 * Metro doesn't support HTTPS natively, so this proxy sits in front:
 *
 *   Browser  --HTTPS-->  this proxy (8082)  --HTTP-->  metro (8081)
 *
 * It also rewrites absolute http://127.0.0.1:8081 URLs that Metro embeds
 * in JS bundles (sourceMappingURL, etc.) to relative paths so the browser
 * fetches them through the proxy instead of hitting Metro directly (which
 * Safari blocks as mixed content).
 *
 * Usage:
 *   node scripts/https-proxy.mjs                 # defaults
 *   PROXY_PORT=9443 METRO_PORT=8081 node scripts/https-proxy.mjs
 */

import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from 'node:net';

const METRO_PORT = Number(process.env.METRO_PORT || 8081);
const PROXY_PORT = Number(process.env.PROXY_PORT || 8082);

const root = resolve(import.meta.dirname, '..');
const cert = readFileSync(process.env.TLS_CERT || resolve(root, 'certs', 'tailscale.crt'));
const key = readFileSync(process.env.TLS_KEY || resolve(root, 'certs', 'tailscale.key'));

const METRO_ORIGIN = `http://127.0.0.1:${METRO_PORT}`;

// Headers to strip from requests (prevent cross-origin issues with Metro)
const STRIP_REQ_HEADERS = new Set(['origin', 'referer', 'accept-encoding']);

// Headers that may contain absolute Metro URLs
const REWRITE_RES_HEADERS = new Set(['sourcemap', 'x-sourcemap', 'location']);

// --- Helpers ---------------------------------------------------------------

function rewriteMetroUrls(str) {
  return str.replaceAll(METRO_ORIGIN, '');
}

function filteredReqHeaders(incomingHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(incomingHeaders)) {
    if (STRIP_REQ_HEADERS.has(k)) continue;
    out[k] = v;
  }
  out.host = `127.0.0.1:${METRO_PORT}`;
  return out;
}

function rewriteResHeaders(rawHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (REWRITE_RES_HEADERS.has(k) && typeof v === 'string') {
      out[k] = rewriteMetroUrls(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function shouldRewriteBody(contentType) {
  if (!contentType) return false;
  return (
    contentType.includes('javascript') ||
    contentType.includes('json') ||
    contentType.includes('text/html')
  );
}

// --- HTTP proxy -----------------------------------------------------------

const server = createServer({ cert, key }, (clientReq, clientRes) => {
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: METRO_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: filteredReqHeaders(clientReq.headers),
    },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const headers = rewriteResHeaders(proxyRes.headers);

      if (shouldRewriteBody(contentType)) {
        // Buffer text responses to rewrite absolute Metro URLs
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const body = rewriteMetroUrls(Buffer.concat(chunks).toString());
          delete headers['content-length'];
          clientRes.writeHead(proxyRes.statusCode, headers);
          clientRes.end(body);
        });
      } else {
        // Stream binary / non-rewritable responses directly
        clientRes.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(clientRes);
      }
    },
  );
  proxyReq.on('error', () => {
    clientRes.writeHead(502);
    clientRes.end('Metro dev server not reachable');
  });
  clientReq.pipe(proxyReq);
});

// --- WebSocket proxy (Metro HMR) -----------------------------------------

server.on('upgrade', (req, clientSocket, head) => {
  const proxySocket = connect({ port: METRO_PORT, host: '127.0.0.1' }, () => {
    // Replay the HTTP upgrade request to metro, stripping origin/referer
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (STRIP_REQ_HEADERS.has(req.rawHeaders[i].toLowerCase())) continue;
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    proxySocket.write(raw);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  proxySocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => proxySocket.destroy());
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(
    `HTTPS proxy listening on https://0.0.0.0:${PROXY_PORT} -> ${METRO_ORIGIN}`,
  );
});
