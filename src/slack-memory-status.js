// Metadata-only operator check. Never emits message bodies or credentials.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const dir = process.env.SLACK_MEMORY_DIR || "/data/slack-memory";
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const database = path.join(dir, "messages.sqlite");
const checkpoint = path.join(dir, "verification-checkpoint.json");
if (!fs.existsSync(database)) {
  console.log(JSON.stringify({ database_present: false }));
  process.exit(1);
}
const db = new DatabaseSync(database, { readOnly: true });
try {
  const total = db.prepare("SELECT count(*) AS n FROM messages").get().n;
  const read = name => {
    try { return JSON.parse(fs.readFileSync(path.join(workspace, "slack-memory", name), "utf8")); }
    catch { return null; }
  };
  const inbox = read("inbox.json");
  const status = read("status.json");
  const result = {
    database_present: true,
    integrity: db.prepare("PRAGMA quick_check").get().quick_check,
    total_records: total,
    deleted_records: db.prepare("SELECT count(*) AS n FROM messages WHERE deleted=1").get().n,
    event_count: db.prepare("SELECT count(*) AS n FROM events").get().n,
    kinds: db.prepare("SELECT COALESCE(kind,'unknown') AS kind,count(*) AS n FROM messages GROUP BY kind").all(),
    snapshot: inbox ? { generated_at: inbox.generated_at, records: inbox.records.length,
      omitted_records: inbox.omitted_records, history_complete: inbox.history_complete } : null,
    status,
  };
  const recordIndex = process.argv.indexOf("--record");
  if (recordIndex !== -1) {
    const key = process.argv.slice(recordIndex + 1, recordIndex + 4);
    if (key.length !== 3) throw new Error("--record requires TEAM CHANNEL TS");
    result.record = db.prepare(`SELECT team,channel,ts,thread_ts,sender,kind,
      deleted,version,received_at,length(text) AS text_length
      FROM messages WHERE team=? AND channel=? AND ts=?`).get(...key) || null;
    if (!result.record) process.exitCode = 1;
  }
  const fingerprints = () => Object.fromEntries(Array.from(db.prepare("SELECT * FROM messages ORDER BY team,channel,ts").iterate(), r => [JSON.stringify([r.team,r.channel,r.ts]),
    crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex")]));
  if (process.argv.includes("--checkpoint")) {
    fs.writeFileSync(checkpoint, JSON.stringify({ at: new Date().toISOString(), records: fingerprints() }), { mode: 0o600 });
    result.checkpoint_saved = total;
  }
  if (process.argv.includes("--compare")) {
    const before = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
    const current = fingerprints();
    const keys = Object.keys(before.records);
    result.persistence = { baseline_at: before.at, baseline_records: keys.length,
      missing: keys.filter(k => !(k in current)).length,
      unchanged: keys.filter(k => before.records[k] === current[k]).length,
      updated: keys.filter(k => k in current && before.records[k] !== current[k]).length };
    if (result.persistence.missing || !keys.length) process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
