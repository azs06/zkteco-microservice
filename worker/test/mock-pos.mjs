// Tiny stand-in for a POS install, for test/e2e.sh (local only).
//   node test/mock-pos.mjs            listens on PORT (default 9797)
// Env: POS_KEY (expected X-Authorization, default "pos-secret"), RECORD (JSON file, default
// $TMPDIR/mock-pos.json), FAIL_FIRST (answer the first N webhook requests with 500).
// Control: POST /__fail?n=N (fail the next N), POST /__reset (clear records), GET /__records.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 9797);
const POS_KEY = process.env.POS_KEY || "pos-secret";
const RECORD = process.env.RECORD || join(tmpdir(), "mock-pos.json");
let failNext = Number(process.env.FAIL_FIRST || 0);
let records = [];

const ROUTES = ["/api/attendance-api/v1/punches", "/api/attendance-api/v1/device-users"];

const save = () => writeFileSync(RECORD, JSON.stringify(records, null, 2));
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/__fail") {
      failNext = Number(url.searchParams.get("n") || 1);
      return send(res, 200, { failNext });
    }
    if (url.pathname === "/__reset") {
      records = [];
      save();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__records") return send(res, 200, records);
    if (req.method !== "POST" || !ROUTES.includes(url.pathname)) return send(res, 404, { error: "Not found" });

    const auth = req.headers["x-authorization"];
    const entry = {
      path: url.pathname,
      auth: auth === POS_KEY,
      deliveryId: req.headers["x-adms-delivery-id"] || null,
      contentType: req.headers["content-type"] || null,
      at: new Date().toISOString(),
    };
    if (auth !== POS_KEY) {
      records.push({ ...entry, status: 401 });
      save();
      return send(res, 401, { error: "Unauthorized" });
    }
    if (failNext > 0) {
      failNext--;
      records.push({ ...entry, status: 500 });
      save();
      return send(res, 500, { error: "Simulated outage" });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "Bad JSON" });
    }
    records.push({ ...entry, status: 200, body });
    save();
    const n = Array.isArray(body.punches) ? body.punches.length : Array.isArray(body.users) ? body.users.length : 0;
    send(res, 200, { received: n });
  });
}).listen(PORT, () => console.log(`mock POS on :${PORT}, key ${POS_KEY}, failing first ${failNext}`));

save();
