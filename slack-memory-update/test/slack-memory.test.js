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
