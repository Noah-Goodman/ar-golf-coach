import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

// The one line every entry point prints when the WebSocket port is taken.
export function portInUseMessage(port) {
  return `Port ${port} is already in use. Another bridge or tool (npm start, fake-shots, replay) ` +
    'may already be running: stop it, or pass --port <n> to the tools.';
}

class BridgeServer extends EventEmitter {
  #http;
  #wss;
  #port;
  #client = null;
  #status = null;
  #closing = null;

  constructor(httpServer) {
    super();
    this.#http = httpServer;
    this.#port = httpServer.address().port;
    // Incoming messages are ignored, so there is no reason to accept large ones.
    this.#wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });
    // The WebSocketServer re-emits HTTP server errors; an unhandled 'error' would crash the process.
    this.#wss.on('error', () => {});
    this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
  }

  get port() {
    return this.#port;
  }

  get hasClient() {
    return this.#client !== null;
  }

  setStatus(message) {
    this.#status = message;
    if (this.#client) this.#send(this.#client, message);
  }

  sendShot(message) {
    if (this.#client) this.#send(this.#client, message);
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = new Promise((resolve) => {
      this.#client = null;
      // terminate() rather than close(): a close handshake waits on the peer, and the
      // WebSocketServer only reports closed once every tracked client is gone.
      for (const ws of this.#wss.clients) ws.terminate();
      this.#wss.close(() => {
        this.#http.close(() => resolve());
        this.#http.closeAllConnections();
      });
    });
    return this.#closing;
  }

  #onConnection(ws, req) {
    const remoteAddress = req.socket.remoteAddress ?? null;
    ws.on('error', () => {});
    if (this.#closing) {
      ws.terminate();
      return;
    }

    const previous = this.#client;
    this.#client = ws;
    if (previous) {
      previous.close(1000, 'replaced');
    }

    ws.on('close', () => {
      // A replaced socket closes after its successor is installed; only the current one counts.
      if (this.#client !== ws) return;
      this.#client = null;
      this.emit('client', { connected: false, remoteAddress });
    });

    this.emit('client', { connected: true, remoteAddress });
    if (this.#status) this.#send(ws, this.#status);
  }

  #send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message), () => {});
  }
}

// options: { port, host = '127.0.0.1' }. port 0 picks a free port.
// Resolves once listening. A taken port rejects with an Error whose code is 'EADDRINUSE'
// and whose message is portInUseMessage(port).
export function createBridgeServer({ port, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('This is a WebSocket endpoint.\n');
    });

    const onListenError = (err) => {
      if (err.code === 'EADDRINUSE') {
        const error = new Error(portInUseMessage(port));
        error.code = 'EADDRINUSE';
        error.port = port;
        reject(error);
      } else {
        reject(err);
      }
    };

    httpServer.once('error', onListenError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onListenError);
      // Errors after listening (rare) must not crash the bridge.
      httpServer.on('error', () => {});
      resolve(new BridgeServer(httpServer));
    });
  });
}
