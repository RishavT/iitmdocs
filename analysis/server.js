/**
 * Node.js HTTP Server Adapter for Cloudflare Worker
 *
 * This adapter allows testing the worker locally without wrangler dev.
 * It converts Node.js HTTP requests to Fetch API format and vice versa.
 */

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .dev.vars
const envFile = readFileSync(join(__dirname, '.dev.vars'), 'utf8');
const envVars = {};
envFile.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      envVars[key.trim()] = valueParts.join('=').trim();
    }
  }
});

console.log('[Server] Loaded environment variables:', Object.keys(envVars));

// Import worker module
const workerModulePath = join(__dirname, 'worker.js');
const workerModule = await import(workerModulePath);

// Mock environment with ASSETS binding
const env = {
  ...envVars,
  ASSETS: {
    fetch: async (request) => {
      // Mock static asset serving
      const url = new URL(request.url);
      if (url.pathname === '/') {
        return new Response('<html><body>IIT Madras BS Chatbot</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        });
      }
      return new Response('Not found', { status: 404 });
    }
  }
};

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Convert Node.js request to Fetch API Request
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  const url = `${protocol}://${host}${req.url}`;

  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  const headers = new Headers();
  Object.entries(req.headers).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(v => headers.append(key, v));
    } else if (value) {
      headers.set(key, value);
    }
  });

  const request = new Request(url, {
    method: req.method,
    headers: headers,
    body: body
  });

  try {
    const response = await workerModule.default.fetch(request, env);

    // Convert Fetch API Response to Node.js response
    res.writeHead(response.status, Object.fromEntries(response.headers));

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (streamError) {
        console.error('[Server] Stream error:', streamError);
      }
    }

    res.end();

    const elapsed = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Response: ${response.status} (${elapsed}ms)`);

  } catch (error) {
    console.error('[Server] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
  }
});

const PORT = process.env.PORT || 8788; // Use 8788 to avoid conflict with wrangler

server.listen(PORT, () => {
  console.log(`\n🚀 Worker server running at http://localhost:${PORT}/`);
  console.log(`📝 Environment: Gemini API (${envVars.CHAT_MODEL || 'unknown model'})`);
  console.log(`🔍 Embeddings: ${envVars.EMBEDDING_PROVIDER || 'unknown'}\n`);
  console.log('Ready to accept requests!\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
