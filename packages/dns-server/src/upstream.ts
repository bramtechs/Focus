import dgram from "node:dgram";
import net from "node:net";
import { Packet } from "dns2";

export type Forwarder = (query: Buffer) => Promise<Buffer>;

interface Upstream {
  host: string;
  port: number;
}

export function parseUpstream(spec: string): Upstream {
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(spec);
  if (v6) return { host: v6[1], port: Number(v6[2] || 53) };
  if (net.isIPv6(spec)) return { host: spec, port: 53 };
  const [host, port] = spec.split(":");
  return { host, port: Number(port || 53) };
}

const isTruncated = (msg: Buffer) => msg.length >= 3 && (msg[2] & 0x02) !== 0;

function queryUdp({ host, port }: Upstream, query: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // One socket per query: a fresh random source port, and no ID clashes between clients.
    const socket = dgram.createSocket(net.isIPv6(host) ? "udp6" : "udp4");
    const done = (err: Error | null, msg?: Buffer) => {
      clearTimeout(timer);
      socket.close();
      err ? reject(err) : resolve(msg!);
    };
    const timer = setTimeout(() => done(new Error(`upstream ${host} timed out`)), timeoutMs);
    socket.on("error", (err) => done(err));
    socket.on("message", (msg, rinfo) => {
      // Ignore anything that isn't the reply to this query.
      if (rinfo.port !== port || msg.length < 2 || msg.readUInt16BE(0) !== query.readUInt16BE(0)) return;
      done(null, msg);
    });
    socket.send(query, port, host);
  });
}

function queryTcp({ host, port }: Upstream, query: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`upstream ${host} timed out`)));
    socket.on("error", reject);
    socket.on("connect", () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length);
      socket.write(Buffer.concat([len, query]));
      Packet.readStream(socket).then(
        (msg) => (socket.end(), resolve(msg)),
        (err) => (socket.destroy(), reject(err))
      );
    });
  });
}

/**
 * Relay raw query bytes to the first upstream that answers (UDP, retrying over
 * TCP when the reply is truncated) and return the raw reply untouched.
 */
export function createForwarder(specs: string[], timeoutMs = 3000): Forwarder {
  const upstreams = specs.map(parseUpstream);
  if (!upstreams.length) throw new Error("No upstream DNS servers configured");
  return async (query) => {
    let lastError: unknown;
    for (const upstream of upstreams) {
      try {
        const reply = await queryUdp(upstream, query, timeoutMs);
        if (!isTruncated(reply)) return reply;
        // If TCP is unreachable, the truncated reply still tells the client to retry.
        return await queryTcp(upstream, query, timeoutMs).catch(() => reply);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };
}

/**
 * Return a copy of a raw DNS message with every record TTL capped at `maxTtl`.
 * Works on the wire format so record types dns2 doesn't model pass through intact.
 * Malformed messages are returned unchanged.
 */
export function capTtl(message: Buffer, maxTtl: number): Buffer {
  if (maxTtl <= 0 || message.length < 12) return message;
  const out = Buffer.from(message);
  const skipName = (off: number) => {
    for (;;) {
      const len = out.readUInt8(off);
      if (len === 0) return off + 1;
      if ((len & 0xc0) === 0xc0) return off + 2; // compression pointer ends the name
      off += len + 1;
    }
  };
  try {
    let off = 12;
    for (let i = out.readUInt16BE(4); i > 0; i--) off = skipName(off) + 4;
    const records = out.readUInt16BE(6) + out.readUInt16BE(8) + out.readUInt16BE(10);
    for (let i = 0; i < records; i++) {
      off = skipName(off);
      const type = out.readUInt16BE(off);
      // OPT (41) reuses the TTL field for EDNS flags; leave it alone.
      if (type !== 41 && out.readUInt32BE(off + 4) > maxTtl) out.writeUInt32BE(maxTtl, off + 4);
      off += 10 + out.readUInt16BE(off + 8);
    }
    return off <= out.length ? out : message;
  } catch {
    return message; // RangeError: truncated or malformed
  }
}
