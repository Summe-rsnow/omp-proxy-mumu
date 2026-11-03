import http from "node:http";
import net from "node:net";
import type stream from "node:stream";
import type { ProxyConfig, ProxyRules } from "./types.js";
import { parseProxyUrl } from "./config.js";
import { toFetchProxyUrl } from "./env.js";

const hostRouteCache = new Map<string, boolean>();
const MAX_ROUTE_CACHE_SIZE = 128;

/**
 * Marks a response the bridge generated because the socks endpoint failed.
 * Bun turns a dead proxy connection into an empty 200, so the caller needs an
 * explicit signal to retry directly instead of using that fake success.
 */
export const PROXY_ERROR_HEADER = "x-omp-proxy-error";

/**
 * Lowercases only when an ASCII uppercase byte is present, avoiding a
 * string allocation for the overwhelmingly common already-lowercase host.
 */
function asciiLower(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 65 && code <= 90) return value.toLowerCase();
  }
  return value;
}

function isLoopbackLower(h: string): boolean {
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.startsWith("127.") ||
    h === "0.0.0.0"
  );
}

export function isLoopback(hostname: string): boolean {
  return isLoopbackLower(asciiLower(hostname));
}

function matchPattern(lowerHostname: string, pattern: string): boolean {
  const p = asciiLower(pattern).trim();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return lowerHostname === suffix || lowerHostname.endsWith(`.${suffix}`);
  }
  return lowerHostname === p;
}

export function clearRouteCache(): void {
  hostRouteCache.clear();
}

/** Current number of cached route decisions (bounded by MAX_ROUTE_CACHE_SIZE). */
export function getRouteCacheSize(): number {
  return hostRouteCache.size;
}

/**
 * High-performance route decision with bounded O(1) in-memory cache.
 */
export function shouldProxyHost(hostname: string, rules: ProxyRules): boolean {
  if (!hostname) return false;
  const lowerHost = asciiLower(hostname);

  // Fast path: loopback is NEVER proxied
  if (isLoopbackLower(lowerHost)) {
    return false;
  }

  // Fast path: cached decision
  const cached = hostRouteCache.get(lowerHost);
  if (cached !== undefined) {
    return cached;
  }

  let decision = true;

  // 1. Direct whitelist
  if (rules.direct.length > 0) {
    for (const pattern of rules.direct) {
      if (matchPattern(lowerHost, pattern)) {
        decision = false;
        break;
      }
    }
  }

  // 2. Explicit proxy list
  if (decision && rules.proxy.length > 0) {
    let matched = false;
    for (const pattern of rules.proxy) {
      if (matchPattern(lowerHost, pattern)) {
        matched = true;
        break;
      }
    }
    decision = matched;
  }

  if (hostRouteCache.size >= MAX_ROUTE_CACHE_SIZE) {
    hostRouteCache.clear();
  }
  hostRouteCache.set(lowerHost, decision);

  return decision;
}

/**
 * Minimalist in-memory HTTP-to-SOCKS5 Bridge.
 * Zero-copy stream piping with native backpressure.
 */
export class Socks5Bridge {
  private server: http.Server | null = null;
  private port: number = 0;
  private targetSocksHost: string = "";
  private targetSocksPort: number = 0;

  async start(socksHost: string, socksPort: number): Promise<string> {
    if (this.server && this.targetSocksHost === socksHost && this.targetSocksPort === socksPort) {
      return `http://127.0.0.1:${this.port}`;
    }

    await this.stop();

    this.targetSocksHost = socksHost;
    this.targetSocksPort = socksPort;

    const { promise, resolve, reject } = Promise.withResolvers<string>();

    // Plain HTTP requests arrive in proxy form (absolute URI); HTTPS arrives as
    // CONNECT. Both are tunnelled through the configured SOCKS5 endpoint.
    this.server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    this.server.on("connect", (req, clientSocket: stream.Duplex, head: Buffer) => {
      void this.handleConnect(req, clientSocket, head);
    });

    this.server.on("error", (err: Error) => {
      reject(err);
    });

    this.server.listen(0, "127.0.0.1", () => {
      const addr = this.server?.address() as net.AddressInfo | null;
      if (addr && addr.port) {
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      } else {
        reject(new Error("Failed to bind Socks5Bridge server"));
      }
    });

    return promise;
  }

  /**
   * Tunnels one client CONNECT (HTTPS) through the SOCKS5 endpoint.
   * On any failure the client socket is destroyed instead of answering 502, so
   * the caller sees a transport error and can fall back to a direct request.
   */
  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: stream.Duplex,
    head: Buffer,
  ): Promise<void> {
    const [destHost, destPortStr] = (req.url || "").split(":");
    const destPort = destPortStr ? Number.parseInt(destPortStr, 10) : 443;

    clientSocket.on("error", () => {});

    if (!destHost || Number.isNaN(destPort)) {
      clientSocket.destroy();
      return;
    }

    try {
      const tunnel = await this.openSocks5Tunnel(destHost, destPort);
      tunnel.on("error", () => clientSocket.destroy());
      clientSocket.on("close", () => tunnel.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) tunnel.write(head);
      clientSocket.pipe(tunnel);
      tunnel.pipe(clientSocket);
    } catch {
      clientSocket.destroy();
    }
  }

  /**
   * Forwards one plain-HTTP proxy request (absolute-form URI) through the
   * SOCKS5 endpoint. Failures are answered with an explicit marker header so
   * the interceptor can retry directly (Bun hides a dropped proxy connection
   * behind an empty 200).
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = req.url ?? "";
    let target: URL;
    try {
      target = new URL(raw.includes("://") ? raw : `http://${req.headers.host ?? ""}${raw}`);
    } catch {
      this.respondProxyFailure(res);
      return;
    }

    const destHost = target.hostname;
    const destPort = target.port ? Number.parseInt(target.port, 10) : 80;
    if (!destHost || Number.isNaN(destPort)) {
      this.respondProxyFailure(res);
      return;
    }

    try {
      const tunnel = await this.openSocks5Tunnel(destHost, destPort);
      const upstream = http.request({
        host: destHost,
        port: destPort,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
        agent: false,
        createConnection: () => tunnel,
      });

      upstream.on("response", (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else this.respondProxyFailure(res);
      });
      req.on("error", () => {
        upstream.destroy();
        tunnel.destroy();
      });
      req.pipe(upstream);
    } catch {
      this.respondProxyFailure(res);
    }
  }

  /** Answers with a marker header instead of a fake success or a silent close. */
  private respondProxyFailure(res: http.ServerResponse): void {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      [PROXY_ERROR_HEADER]: "socks5-endpoint-failed",
    });
    res.end("omp-proxy-mumu: socks5 endpoint failed\n");
  }

  /**
   * Opens a SOCKS5 (no-auth) tunnel to the destination.
   * Resolves once the CONNECT reply is successful, with any extra bytes pushed
   * back into the socket stream.
   */
  private openSocks5Tunnel(destHost: string, destPort: number): Promise<net.Socket> {
    const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
    const socket = net.createConnection({
      host: this.targetSocksHost,
      port: this.targetSocksPort,
    });

    socket.setTimeout(5000);

    let buffered = Buffer.alloc(0);
    let greeted = false;

    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };

    socket.on("connect", () => {
      // 1. Greeting: version 5, one method, no-auth.
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on("error", fail);
    socket.on("timeout", () => fail(new Error("socks5 handshake timeout")));

    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);

      if (!greeted) {
        if (buffered.length < 2) return;
        if (buffered[0] !== 0x05 || buffered[1] !== 0x00) {
          fail(new Error("socks5 auth rejected"));
          return;
        }
        buffered = buffered.subarray(2);
        greeted = true;

        // 2. Connect request using the domain address type.
        const domain = Buffer.from(destHost);
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(destPort, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, portBytes]));
      }

      if (buffered.length < 5) return;
      if (buffered[0] !== 0x05) {
        fail(new Error("socks5 protocol error"));
        return;
      }
      if (buffered[1] !== 0x00) {
        fail(new Error(`socks5 connect failed (code ${buffered[1]})`));
        return;
      }

      const atyp = buffered[3];
      const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buffered[4]! : -1;
      if (addressLength < 0) {
        fail(new Error("socks5 unknown address type"));
        return;
      }

      const replyLength = 4 + addressLength + 2;
      if (buffered.length < replyLength) return;

      socket.off("data", onData);
      socket.setTimeout(0);
      const leftover = buffered.subarray(replyLength);
      if (leftover.length > 0) socket.unshift(leftover);
      resolve(socket);
    };

    socket.on("data", onData);
    return promise;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.port = 0;
    const { promise, resolve } = Promise.withResolvers<void>();
    s.close(() => resolve());
    return promise;
  }
}

export class TunnelManager {
  private bridge: Socks5Bridge | null = null;

  async getFetchProxyUrl(config: ProxyConfig): Promise<string | null> {
    const parsed = parseProxyUrl(config.url);
    if (!parsed) return null;

    if (parsed.protocol.startsWith("socks")) {
      if (!this.bridge) {
        this.bridge = new Socks5Bridge();
      }
      // The bridge speaks HTTP CONNECT, which is what Bun's fetch accepts.
      return this.bridge.start(parsed.host, parsed.port);
    }

    // Canonical form (IPv6 brackets, no duplicate separators); null when the
    // URL is not something Bun's fetch can use as a proxy.
    return toFetchProxyUrl(config.url);
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }
  }
}
