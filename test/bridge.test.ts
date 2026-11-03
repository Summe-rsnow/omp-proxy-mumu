import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { PROXY_ERROR_HEADER, Socks5Bridge } from "../src/tunnel.js";

/**
 * Minimal SOCKS5 (no-auth) server: accepts one CONNECT request and pipes bytes
 * to the destination. Enough to exercise the bridge without external network.
 */
function startSocks5Server(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let stage = 0;
    let buffered = Buffer.alloc(0);

    client.on("data", (chunk) => {
      if (stage === 2) return;
      buffered = Buffer.concat([buffered, chunk]);

      if (stage === 0) {
        if (buffered.length < 2) return;
        const methods = buffered[1]!;
        if (buffered.length < 2 + methods) return;
        buffered = buffered.subarray(2 + methods);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }

      if (buffered.length < 5) return;
      const atyp = buffered[3]!;
      let host: string;
      let cursor: number;
      if (atyp === 0x01) {
        if (buffered.length < 10) return;
        host = `${buffered[4]}.${buffered[5]}.${buffered[6]}.${buffered[7]}`;
        cursor = 8;
      } else if (atyp === 0x03) {
        const length = buffered[4]!;
        if (buffered.length < 5 + length + 2) return;
        host = buffered.subarray(5, 5 + length).toString();
        cursor = 5 + length;
      } else {
        client.destroy();
        return;
      }

      const port = buffered.readUInt16BE(cursor);
      const rest = buffered.subarray(cursor + 2);
      stage = 2;

      const upstream = net.createConnection({ host, port }, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  });

  const listening = Promise.withResolvers<{ port: number; close: () => void }>();
  server.listen(0, "127.0.0.1", () => {
    listening.resolve({
      port: (server.address() as net.AddressInfo).port,
      close: () => server.close(),
    });
  });
  return listening.promise;
}

const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("bridged") });
let socks: { port: number; close: () => void };
let bridge: Socks5Bridge;
let bridgeUrl = "";

beforeAll(async () => {
  socks = await startSocks5Server();
  bridge = new Socks5Bridge();
  bridgeUrl = await bridge.start("127.0.0.1", socks.port);
});

afterAll(async () => {
  await bridge.stop();
  socks.close();
  target.stop(true);
});

describe("Socks5Bridge", () => {
  test("forwards plain-HTTP requests through the socks endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${target.port}/hello?x=1`, { proxy: bridgeUrl });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bridged");
  });

  test("tunnels CONNECT so HTTPS-style clients keep working", async () => {
    const url = new URL(bridgeUrl);
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    const { promise, resolve } = Promise.withResolvers<string>();
    let received = "";

    socket.on("connect", () => {
      socket.write(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("200 Connection Established") && !received.includes("GET /")) {
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: close\r\n\r\n`);
      }
      if (received.includes("bridged")) {
        resolve("ok");
        socket.destroy();
      }
    });
    socket.on("error", () => resolve(`error: ${received.slice(0, 60)}`));

    expect(await promise).toBe("ok");
  });

  test("marks bridge failures instead of faking a 200", async () => {
    const dead = new Socks5Bridge();
    const deadUrl = await dead.start("127.0.0.1", 1);
    const response = await fetch(`http://127.0.0.1:${target.port}/`, { proxy: deadUrl });
    expect(response.status).toBe(502);
    expect(response.headers.get(PROXY_ERROR_HEADER)).toBe("socks5-endpoint-failed");
    await dead.stop();
  });
});
