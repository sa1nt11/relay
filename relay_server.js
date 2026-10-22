// beg4ciferr relay: plain node, no dependencies.
// env on Render:  RELAY_KEY = same as RELAY_KEY in the script
//                 OWNER_SECRET = long random string, same as getgenv().BC_OWNER in YOUR executor only
const http = require("http");
const { URL } = require("url");

const RELAY_KEY = process.env.RELAY_KEY || "raven-raven-6899-4fc613";
const OWNER_SECRET = process.env.OWNER_SECRET || "";
const PORT = process.env.PORT || 3000;
const CMD = "::bc4cmd::";
const KEEP = 200;        // messages kept per room
const FIRST_POLL = 50;   // history sent on a fresh join (since=0)

const rooms = new Map(); // room -> { next, msgs }

function room(name) {
	if (!rooms.has(name)) rooms.set(name, { next: 1, msgs: [] });
	return rooms.get(name);
}

function send(res, code, obj) {
	res.writeHead(code, { "Content-Type": "application/json" });
	res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");

	if (url.pathname === "/") return send(res, 200, { ok: true });
	if (req.headers["x-key"] !== RELAY_KEY) return send(res, 401, { ok: false });

	if (req.method === "GET" && url.pathname === "/poll") {
		const r = room(String(url.searchParams.get("room") || "global").slice(0, 100));
		const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
		let list = r.msgs.filter((m) => m.id > since);
		if (since === 0) list = list.slice(-FIRST_POLL);
		return send(res, 200, { messages: list });
	}

	if (req.method === "POST" && url.pathname === "/send") {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
			if (raw.length > 5000) req.destroy();
		});
		req.on("end", () => {
			let body;
			try { body = JSON.parse(raw); } catch { return send(res, 400, { ok: false }); }

			const text = String(body.text || "").slice(0, 300);
			const isOwner = OWNER_SECRET !== "" && req.headers["x-owner"] === OWNER_SECRET;

			// only the owner may send command messages
			if (text.startsWith(CMD) && !isOwner) return send(res, 403, { ok: false });
			if (!text) return send(res, 400, { ok: false });

			const r = room(String(body.room || "global").slice(0, 100));
			r.msgs.push({
				id: r.next++,
				name: String(body.name || "?").slice(0, 40),
				uid: Number(body.uid) || 0,
				text,
				ts: Date.now(),
				admin: isOwner, // set by the server only, never copied from the request body
			});
			if (r.msgs.length > KEEP) r.msgs.splice(0, r.msgs.length - KEEP);
			return send(res, 200, { ok: true });
		});
		return;
	}

	send(res, 404, { ok: false });
});

server.listen(PORT, () => console.log("relay on " + PORT));
