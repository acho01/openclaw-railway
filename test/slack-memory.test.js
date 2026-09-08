import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SlackMemoryStore } from "../src/slack-memory.js";

test("messages survive reopening; duplicates, edits, deletes and late retries are safe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-memory-test-"));
  let store = new SlackMemoryStore(path.join(dir, "messages.sqlite"));
  const event = (id, data) => ({ event_id: id, team_id: "T1", event: { type: "message", channel: "C1", ...data } });
  try {
    const original = event("E1", { ts: "100.000001", event_ts: "100.000001", text: "First", user: "U1" });
    assert.equal(store.ingest(original), true);
    assert.equal(store.ingest(original), false);
    store.close();
    store = new SlackMemoryStore(path.join(dir, "messages.sqlite"));
    assert.equal(store.rows()[0].text, "First");
    store.ingest(event("E2", { subtype: "message_changed", event_ts: "102.000001", message: { ts: "100.000001", text: "Edited", user: "U1" } }));
    store.ingest(event("E3", { ts: "100.000001", event_ts: "101.000001", text: "Stale" }));
    assert.equal(store.rows()[0].text, "Edited");
    store.ingest(event("E4", { subtype: "message_deleted", event_ts: "103.000001", deleted_ts: "100.000001" }));
    store.ingest(event("E5", { ts: "100.000001", event_ts: "104.000001", text: "Must not resurrect" }));
    assert.equal(store.rows()[0].text, "");
    assert.equal(store.rows()[0].deleted, 1);
    const filename = path.join(dir, "snapshot.json");
    store.snapshot(filename, { url: "https://test.slack.com/", user_id: "U1", team_id: "T1" });
    const snapshot = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(snapshot.records[0].deleted, 1);
    assert.equal(snapshot.records[0].source_url, "https://test.slack.com/archives/C1/p100000001");
    assert.equal(snapshot.owner, "U1");
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("DM and group-DM records retain routing, thread, and workspace identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-memory-test-"));
  const store = new SlackMemoryStore(path.join(dir, "messages.sqlite"));
  try {
    for (const [team, channel, kind] of [["T1", "D1", "im"], ["T1", "G1", "mpim"], ["T2", "D1", "im"]]) {
      store.ingest({ event_id: team + channel, team_id: team, event: {
        type: "message", channel, channel_type: kind, ts: "100.000001", thread_ts: "99.000001", user: "U1", text: "Data",
      } });
    }
    assert.equal(store.rows().length, 3);
    assert.ok(store.rows().every(r => r.thread_ts === "99.000001"));
    assert.equal(store.ingest({ event_id: "non-message", event: { type: "reaction_added" } }), false);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const identity = { ok: true, url: "https://test.slack.com/", user_id: "U1", team_id: "T1" };
const scopes = "channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read";
const payload = (id, data) => ({ event_id: id, team_id: "T1", event: { type: "message", channel: "G1", ...data } });

import { validateIdentity, startSlackMemory } from "../src/slack-memory.js";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";

test("scope validation fails closed on missing, incomplete and mutation scopes", () => {
  assert.doesNotThrow(() => validateIdentity(identity, scopes));
  assert.doesNotThrow(() => validateIdentity(identity, "identify," + scopes));
  for (const value of [null, "", "users:read", scopes + ",chat:write.public", scopes + ",reactions:write", scopes + ",admin", scopes + ",im:write"]) {
    assert.throws(() => validateIdentity(identity, value));
  }
  assert.throws(() => validateIdentity({ ...identity, url: "https://untrusted.example/" }, scopes));
});

test("edit/delete envelopes without event_ts preserve thread, sender and private-channel kind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-memory-test-"));
  const store = new SlackMemoryStore(path.join(dir, "messages.sqlite"));
  try {
    store.ingest(payload("initial", { ts: "100.000001", text: "Old", user: "U1", channel_type: "group", thread_ts: "99.000001" }));
    store.ingest(payload("edit", { subtype: "message_changed", ts: "102.000001", message: { ts: "100.000001", text: "New" } }));
    assert.equal(store.rows()[0].version, 102.000001);
    assert.equal(store.rows()[0].thread_ts, "99.000001");
    assert.equal(store.rows()[0].sender, "U1");
    assert.equal(store.rows()[0].kind, "group");
    assert.equal(store.ingest(payload("stale", { ts: "100.000001", text: "Stale" })), false);
    store.ingest(payload("delete", { subtype: "message_deleted", ts: "103.000001", deleted_ts: "100.000001" }));
    assert.equal(store.rows()[0].version, 103.000001);
    assert.equal(store.rows()[0].kind, "group");
    assert.equal(store.rows()[0].text, "");
    assert.equal(store.rows()[0].sender, "U1");
    store.ingest(payload("before-original", { subtype: "message_deleted", ts: "201.000001", deleted_ts: "200.000001" }));
    store.ingest(payload("late-original", { ts: "200.000001", text: "Do not restore" }));
    assert.equal(store.rows()[0].deleted, 1);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bounded snapshot caps text, reports omissions, keeps full DB text, and updates old edited records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-memory-test-"));
  const store = new SlackMemoryStore(path.join(dir, "messages.sqlite"));
  const file = path.join(dir, "inbox.json");
  try {
    for (let i = 1; i <= 205; i++) store.ingest(payload(`E${i}`, { ts: `${i}.000001`, text: "x".repeat(6001) }));
    store.snapshot(file, identity);
    let snapshot = JSON.parse(fs.readFileSync(file));
    assert.equal(snapshot.records.length, 200);
    assert.equal(snapshot.omitted_records, 5);
    assert.equal(snapshot.history_complete, false);
    assert.equal(snapshot.records[0].text.length, 6000);
    assert.equal(snapshot.records[0].text_truncated, true);
    assert.equal(store.rows()[0].text.length, 6001);
    store.ingest(payload("edit-old", { subtype: "message_changed", event_ts: "300.000001", message: { ts: "1.000001", text: "Updated" } }));
    store.snapshot(file, identity);
    snapshot = JSON.parse(fs.readFileSync(file));
    assert.equal(snapshot.records[0].ts, "1.000001");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "messages.sqlite")).mode & 0o777, 0o600);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("transport acknowledges after commit, retries database failures, ignores other teams and stops cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-memory-test-"));
  const logs = [];
  const client = new EventEmitter();
  client.start = async () => { client.emit("connected"); };
  client.disconnect = async () => { client.emit("disconnected"); };
  const stop = startSlackMemory({ SLACK_MEMORY_APP_TOKEN: "secret-app", SLACK_MEMORY_USER_TOKEN: "secret-user", SLACK_MEMORY_DIR: dir, OPENCLAW_WORKSPACE_DIR: dir }, value => logs.push(value), {
    fetchImpl: async () => ({ json: async () => identity, headers: { get: () => scopes } }),
    createClient: () => client,
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const [receive] = client.listeners("slack_event");
    const event = payload("E1", { ts: "100.000001", text: "private-body" });
    let acknowledgements = 0;
    const ack = async () => {
      const db = new DatabaseSync(path.join(dir, "messages.sqlite"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT text FROM messages").get().text, "private-body"); }
      finally { db.close(); }
      acknowledgements++;
    };
    await receive({ body: event, ack });
    await receive({ body: event, ack });
    assert.equal(acknowledgements, 2);
    const db = new DatabaseSync(path.join(dir, "messages.sqlite"));
    try {
      db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
      await receive({ body: { ...event, event_id: "E2" }, ack });
      assert.equal(acknowledgements, 2);
      db.exec("DROP TRIGGER reject_event");
      await receive({ body: { ...event, event_id: "E2" }, ack });
      assert.equal(acknowledgements, 3);
      await receive({ body: { ...event, team_id: "T-other", event_id: "E3" }, ack: async () => { acknowledgements++; } });
      assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 2);
    } finally { db.close(); }
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "slack-memory/inbox.json")));
    assert.equal(snapshot.records[0].text, "private-body");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "slack-memory/status.json"))).connected, true);
    assert.ok(logs.every(l => !/secret-|private-body/.test(l)));
    stop(); stop();
    await receive({ body: event, ack });
    assert.equal(acknowledgements, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "slack-memory/status.json"))).connected, false);
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

import { spawnSync } from "node:child_process";

test("a committed WAL survives abrupt process exit before a store close", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-memory-crash-test-"));
  const file = path.join(dir, "messages.sqlite");
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { SlackMemoryStore } from ${JSON.stringify(new URL("../src/slack-memory.js", import.meta.url).href)};
      const store = new SlackMemoryStore(${JSON.stringify(file)});
      store.ingest(${JSON.stringify(payload("crash-event", { ts: "100.000001", text: "Committed before crash" }))});
      process.exit(0);
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const store = new SlackMemoryStore(file);
    try { assert.equal(store.rows()[0].text, "Committed before crash"); }
    finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
