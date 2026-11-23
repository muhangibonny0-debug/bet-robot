'use strict';
// Zero-cost Phone-as-Gateway tunnel server for BetRobot (runs inside GitHub Actions or locally).
// Exposes:
//   1) Local HTTP/HTTPS CONNECT proxy on 127.0.0.1:<proxyPort> for Playwright Chromium.
//   2) Authenticated RFC-6455 WebSocket server on 127.0.0.1:<wsPort>, optionally exposed via
//      Cloudflare Quick Tunnel (cloudflared --url http://127.0.0.1:<wsPort>) with zero cost / zero account.
//   3) Exact upload + download byte accounting with configurable MB limit (default 200 MB).
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Minimal RFC-6455 WebSocket server connection (handles text + binary + ping/pong + close frames).
class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._cleanup());
    socket.on('error', () => this._cleanup());
  }

  _cleanup() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      this.buf = this.buf.subarray(off + maskLen + len);
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      if (opcode === 0x8) { // close
        this.close();
        return;
      } else if (opcode === 0x9) { // ping
        this._sendFrame(0xA, payload);
      } else if (opcode === 0x1) { // text
        this.emit('text', payload.toString('utf8'));
      } else if (opcode === 0x2) { // binary
        this.emit('binary', payload);
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
    const len = data.length;
    let hdr;
    if (len < 126) {
      hdr = Buffer.alloc(2);
      hdr[0] = 0x80 | opcode;
      hdr[1] = len;
    } else if (len < 65536) {
      hdr = Buffer.alloc(4);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 126;
      hdr.writeUInt16BE(len, 2);
    } else {
      hdr = Buffer.alloc(10);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 127;
      hdr.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([hdr, data]));
  }

  sendJson(obj) { this._sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  sendBinary(buf) { this._sendFrame(0x2, buf); }
  close() {
    if (this.closed) return;
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (_) {}
    try { this.socket.end(); } catch (_) {}
    this._cleanup();
  }
}

class PhoneGatewayServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.limitMb = Number(opts.limitMb) > 0 ? Number(opts.limitMb) : 200;
    this.limitBytes = Math.round(this.limitMb * 1024 * 1024);
    this.token = opts.token || crypto.randomBytes(24).toString('hex');
    this.wsServer = null;
    this.proxyServer = null;
    this.wsPort = 0;
    this.proxyPort = 0;
    this.publicUrl = '';
    this.tunnelProc = null;
    this.phone = null;
    this.nextId = 1;
    this.streams = new Map(); // id -> { socket, onOpened, onErr }
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.warned80 = false;
    this.limitReached = false;
    this.everConnected = false;
    this.disconnectedAt = 0;
    this.heartbeat = null;
  }

  get totalBytes() { return this.bytesUp + this.bytesDown; }
  get usedMb() { return Math.round((this.totalBytes / (1024 * 1024)) * 100) / 100; }
  get connected() { return !!(this.phone && !this.phone.closed); }

  status() {
    return {
      active: true,
      connected: this.connected,
      everConnected: this.everConnected,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
      totalBytes: this.totalBytes,
      usedMb: this.usedMb,
      limitMb: this.limitMb,
      limitBytes: this.limitBytes,
      warned80: this.warned80,
      limitReached: this.limitReached,
      disconnected: this.everConnected && !this.connected && !this.limitReached,
    };
  }

  _account(bytes, dir) {
    if (!bytes || bytes <= 0) return;
    if (dir === 'up') this.bytesUp += bytes;
    else this.bytesDown += bytes;
    if (!this.warned80 && this.totalBytes >= this.limitBytes * 0.8) {
      this.warned80 = true;
      this.emit('warning80', this.status());
    }
    if (!this.limitReached && this.totalBytes >= this.limitBytes) {
      this.limitReached = true;
      this._abortAllStreams('Mobile data limit reached');
      if (this.phone && !this.phone.closed) {
        this.phone.sendJson({ t: 'limit', bytes: this.totalBytes, limit: this.limitBytes });
      }
      this.emit('limitReached', this.status());
    }
  }

  _abortAllStreams(reason) {
    for (const [id, st] of this.streams.entries()) {
      try { if (st.onErr) st.onErr(reason); } catch (_) {}
      try { st.socket.destroy(); } catch (_) {}
      this.streams.delete(id);
    }
  }

  async start({ useCloudflared = true, cloudflaredBin = 'cloudflared' } = {}) {
    // 1) WebSocket server on 127.0.0.1:0
    this.wsServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('BetRobot Gateway Ready\n');
    });
    this.wsServer.on('upgrade', (req, socket) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const tok = u.searchParams.get('token') || req.headers['x-gateway-token'] || '';
        if (tok !== this.token) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const key = req.headers['sec-websocket-key'];
        if (!key) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }
        const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        const conn = new WsConn(socket);
        if (this.phone && !this.phone.closed) this.phone.close();
        this.phone = conn;
        this.everConnected = true;
        this.disconnectedAt = 0;
        this.emit('connected');
        conn.on('text', (txt) => this._onPhoneText(txt));
        conn.on('binary', (buf) => this._onPhoneBinary(buf));
        conn.on('close', () => {
          if (this.phone === conn) {
            this.phone = null;
            this.disconnectedAt = Date.now();
            this._abortAllStreams('Phone gateway disconnected');
            this.emit('disconnected');
          }
        });
      } catch (_) {
        socket.destroy();
      }
    });
    await new Promise((resolve) => this.wsServer.listen(0, '127.0.0.1', resolve));
    this.wsPort = this.wsServer.address().port;

    // 2) Local HTTP/HTTPS CONNECT proxy on 127.0.0.1:0 for Playwright
    this.proxyServer = http.createServer((req, res) => {
      // Plain HTTP request forwarding via CONNECT-style stream
      if (this.limitReached) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Phone gateway data limit reached');
        return;
      }
      if (!this.connected) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Phone gateway not connected');
        return;
      }
      try {
        const u = new URL(req.url);
        const host = u.hostname;
        const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
        const id = this.nextId++;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const headLines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'Connection: close'];
          for (const [k, v] of Object.entries(req.headers)) {
            if (/^(proxy-|connection|host)/i.test(k)) continue;
            headLines.push(`${k}: ${v}`);
          }
          const rawReq = Buffer.concat([Buffer.from(headLines.join('\r\n') + '\r\n\r\n'), body]);
          this._openStream(id, host, port, req.socket, () => {
            this._sendStreamData(id, rawReq);
          }, () => {
            try { res.writeHead(502); res.end('Gateway upstream error'); } catch (_) {}
          }, true);
        });
      } catch (_) {
        res.writeHead(400);
        res.end('Bad proxy request');
      }
    });

    this.proxyServer.on('connect', (req, clientSocket, head) => {
      if (this.limitReached) {
        clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      if (!this.connected) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      const [host, portStr] = String(req.url || '').split(':');
      const port = Number(portStr) || 443;
      const id = this.nextId++;
      this._openStream(id, host, port, clientSocket, () => {
        if (clientSocket.destroyed) return;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) this._sendStreamData(id, head);
        clientSocket.on('data', (chunk) => this._sendStreamData(id, chunk));
        clientSocket.on('close', () => this._closeStream(id));
        clientSocket.on('error', () => this._closeStream(id));
      }, () => {
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {}
        try { clientSocket.destroy(); } catch (_) {}
      }, false);
    });

    await new Promise((resolve) => this.proxyServer.listen(0, '127.0.0.1', resolve));
    this.proxyPort = this.proxyServer.address().port;

    // Heartbeat every 15s to keep Cloudflare/mobile NAT alive
    this.heartbeat = setInterval(() => {
      if (this.phone && !this.phone.closed) {
        this.phone.sendJson({ t: 'ping', usedMb: this.usedMb, limitMb: this.limitMb });
      }
    }, 15000);

    // 3) Optionally expose wsPort via Cloudflare Quick Tunnel (zero cost, zero account)
    if (useCloudflared) {
      this.publicUrl = await this._startCloudflared(cloudflaredBin);
    } else {
      this.publicUrl = `ws://127.0.0.1:${this.wsPort}`;
    }
    return {
      proxyUrl: `http://127.0.0.1:${this.proxyPort}`,
      gatewayUrl: `${this.publicUrl}/gw`,
      gatewayToken: this.token,
    };
  }

  _startCloudflared(bin) {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.wsPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.tunnelProc = proc;
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('cloudflared quick tunnel did not emit a trycloudflare.com URL within 30s'));
        }
      }, 30000);
      const scan = (chunk) => {
        const s = chunk.toString('utf8');
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(m[0].replace(/^https:/i, 'wss:'));
        }
      };
      proc.stdout.on('data', scan);
      proc.stderr.on('data', scan);
      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared launch failed: ${err.message}`));
        }
      });
      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared exited early with code ${code}`));
        }
      });
    });
  }

  _openStream(id, host, port, socket, onOpened, onErr, rawHttp) {
    if (!this.phone || this.phone.closed || this.limitReached) {
      if (onErr) onErr('unavailable');
      return;
    }
    this.streams.set(id, { socket, onOpened, onErr, rawHttp });
    this.phone.sendJson({ t: 'open', id, host, port });
  }

  _sendStreamData(id, chunk) {
    if (!this.phone || this.phone.closed || this.limitReached || !chunk || !chunk.length) return;
    this._account(chunk.length, 'up');
    if (this.limitReached) return;
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(id, 0);
    this.phone.sendBinary(Buffer.concat([hdr, chunk]));
  }

  _closeStream(id) {
    if (!this.streams.has(id)) return;
    this.streams.delete(id);
    if (this.phone && !this.phone.closed) {
      this.phone.sendJson({ t: 'close', id });
    }
  }

  _onPhoneText(txt) {
    let msg;
    try { msg = JSON.parse(txt); } catch (_) { return; }
    if (msg.t === 'opened') {
      const st = this.streams.get(msg.id);
      if (st && st.onOpened) st.onOpened();
    } else if (msg.t === 'err') {
      const st = this.streams.get(msg.id);
      if (st) {
        this.streams.delete(msg.id);
        if (st.onErr) st.onErr(msg.msg || 'connect failed');
      }
    } else if (msg.t === 'close') {
      const st = this.streams.get(msg.id);
      if (st) {
        this.streams.delete(msg.id);
        try { st.socket.end(); } catch (_) {}
      }
    } else if (msg.t === 'limit') {
      if (!this.limitReached) {
        this.limitReached = true;
        this._abortAllStreams('Phone reported data limit reached');
        this.emit('limitReached', this.status());
      }
    }
  }

  _onPhoneBinary(buf) {
    if (!buf || buf.length < 4) return;
    const id = buf.readUInt32BE(0);
    const payload = buf.subarray(4);
    this._account(payload.length, 'down');
    if (this.limitReached) return;
    const st = this.streams.get(id);
    if (st && !st.socket.destroyed) {
      st.socket.write(payload);
    }
  }

  waitForPhone(timeoutMs = 120000) {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('connected', onConn);
        resolve(false);
      }, timeoutMs);
      const onConn = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('connected', onConn);
    });
  }

  async close() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.phone && !this.phone.closed) {
      try { this.phone.sendJson({ t: 'done', usedMb: this.usedMb }); } catch (_) {}
      this.phone.close();
    }
    this._abortAllStreams('Gateway closing');
    if (this.tunnelProc) { try { this.tunnelProc.kill(); } catch (_) {} this.tunnelProc = null; }
    if (this.proxyServer) { await new Promise((r) => this.proxyServer.close(r)); this.proxyServer = null; }
    if (this.wsServer) { await new Promise((r) => this.wsServer.close(r)); this.wsServer = null; }
  }
}

module.exports = { PhoneGatewayServer };
