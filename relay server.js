// relay_server.js - tiny private chat relay for beg4ciferr
// run: RELAY_KEY=your-secret node relay_server.js   (no npm install needed)
//
// - only requests with the right x-key header get in
// - messages live in memory per room and expire, nothing is written to disk
// - not encrypted end to end: whoever runs the server can read the messages

const http = require("http");
const crypto = require("crypto");

const KEY = process.env.RELAY_KEY || "change-me";
const PORT = process.env.PORT || 3000;
const MAX_KEEP = 100;            // messages kept per room
const FIRST_POLL = 30;           // how many recent messages a new client gets
const MAX_TEXT = 200;
const MAX_NAME = 24;
const SEND_COOLDOWN_MS = 1000;   // per sender
const ROOM_TTL_MS = 6 * 3600 * 1000;

const rooms = new Map();         // room -> { nextId, msgs, touched }
const lastSend = new Map();      // sender key -> time

if (KEY === "change-me") {
  console.warn("WARNING: RELAY_KEY is not set, anyone who guesses 'change-me' can use this relay");
}

function keyOk(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = { nextId: 1, msgs: [], touched: Date.now() };
    rooms.set(name, r);
  }
  r.touched = Date.now();
  return r;
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > 4096) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => cb(Buffer.concat(chunks).toString("utf8")));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/" && req.method === "GET") {
    return send(res, 200, { ok: true });
  }
  if (!keyOk(req.headers["x-key"])) {
    return send(res, 401, { ok: false });
  }

  if (url.pathname === "/poll" && req.method === "GET") {
    const room = clean(url.searchParams.get("room"), 64);
    const since = parseInt(url.searchParams.get("since"), 10) || 0;
    if (!room) return send(res, 400, { ok: false });
    const r = getRoom(room);
    const out = since <= 0 ? r.msgs.slice(-FIRST_POLL) : r.msgs.filter((m) => m.id > since);
    return send(res, 200, { ok: true, messages: out });
  }

  if (url.pathname === "/send" && req.method === "POST") {
    return readBody(req, (raw) => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { ok: false });
      }
      const room = clean(body.room, 64);
      const text = clean(body.text, MAX_TEXT);
      const name = clean(body.name, MAX_NAME) || "?";
      const uid = Number(body.uid) || 0;
      if (!room || !text) return send(res, 400, { ok: false });

      const who = uid || req.socket.remoteAddress;
      const now = Date.now();
      if (now - (lastSend.get(who) || 0) < SEND_COOLDOWN_MS) {
        return send(res, 429, { ok: false });
      }
      lastSend.set(who, now);

      const r = getRoom(room);
      r.msgs.push({ id: r.nextId++, name, uid, text, t: now });
      if (r.msgs.length > MAX_KEEP) r.msgs.shift();
      return send(res, 200, { ok: true });
    });
  }

  send(res, 404, { ok: false });
});

// drop idle rooms and old rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [name, r] of rooms) {
    if (now - r.touched > ROOM_TTL_MS) rooms.delete(name);
  }
  for (const [who, t] of lastSend) {
    if (now - t > 60000) lastSend.delete(who);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log("relay listening on " + PORT));
