import http from "node:http";
import net from "node:net";
import type stream from "node:stream";
import type { ProxyConfig, ProxyRules } from "./types.js";
import { parseProxyUrl } from "./config.js";

const hostRouteCache = new Map<string, boolean>();
const MAX_ROUTE_CACHE_SIZE = 128;

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

    this.server = http.createServer((_req, res) => {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Socks5Bridge: Use HTTP CONNECT method only\n");
    });

    this.server.on("connect", (req, clientSocket: stream.Duplex, head: Buffer) => {
      const [destHost, destPortStr] = (req.url || "").split(":");
      const destPort = destPortStr ? Number.parseInt(destPortStr, 10) : 443;

      if (!destHost || Number.isNaN(destPort)) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.end();
        return;
      }

      this.createSocks5Connection(destHost, destPort, clientSocket, head);
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

  private createSocks5Connection(
    destHost: string,
    destPort: number,
    clientSocket: stream.Duplex,
    head: Buffer,
  ): void {
    const socksSocket = net.createConnection({
      host: this.targetSocksHost,
      port: this.targetSocksPort,
    });

    socksSocket.setTimeout(5000);

    socksSocket.on("timeout", () => {
      clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      clientSocket.destroy();
      socksSocket.destroy();
    });

    socksSocket.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });

    clientSocket.on("error", () => {
      socksSocket.destroy();
    });

    // 1. Send SOCKS5 Greeting (No Auth)
    socksSocket.on("connect", () => {
      socksSocket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let state: "greeting" | "connecting" | "piped" = "greeting";

    socksSocket.on("data", (data: Buffer) => {
      if (state === "greeting") {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
          socksSocket.destroy();
          return;
        }

        // 2. Send SOCKS5 Connect Request (domain type 0x03)
        state = "connecting";
        const domainBuf = Buffer.from(destHost);
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(destPort, 0);

        const request = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
          domainBuf,
          portBuf,
        ]);
        socksSocket.write(request);
      } else if (state === "connecting") {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
          socksSocket.destroy();
          return;
        }

        // 3. Success! Establish bidirectional zero-copy pipe
        state = "piped";
        socksSocket.setTimeout(0); // clear connect timeout
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        if (head && head.length > 0) {
          socksSocket.write(head);
        }

        clientSocket.pipe(socksSocket);
        socksSocket.pipe(clientSocket);
      }
    });
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
      return this.bridge.start(parsed.host, parsed.port);
    }

    return `http://${parsed.host}:${parsed.port}`;
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }
  }
}
