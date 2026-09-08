import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("manual runner carries large evidence over stdin, disables tools/delivery and preserves owner tasks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-test-"));
  try {
    fs.mkdirSync(path.join(dir, "slack-memory"));
    fs.mkdirSync(path.join(dir, "planner"));
    fs.writeFileSync(path.join(dir, "planner/tasks.md"), "Owner accepted: preserve this decision.");
    fs.writeFileSync(path.join(dir, "slack-memory/inbox.json"), JSON.stringify({
      owner: "U1", records: Array.from({ length: 200 }, (_, i) => ({ ts: `${i}.000001`, text: "x".repeat(6000) })),
    }));
    const stub = path.join(dir, "openclaw-stub.mjs");
    fs.writeFileSync(stub, `
      import assert from 'node:assert/strict';
      const p = JSON.parse(process.argv[process.argv.indexOf('--params') + 1]);
      if (process.argv[4] === 'chat.inject') {
        assert.equal(p.sessionKey, 'agent:main:main');
        assert.ok(p.message.includes('Draft for private review'));
        console.log(JSON.stringify({ ok: true }));
        process.exit(0);
      }
      assert.equal(p.modelRun, true);
      assert.equal(p.disableMessageTool, true);
      assert.equal(p.deliver, false);
      assert.equal(p.sessionEffects, undefined);
      assert.equal(p.promptMode, 'none');
      assert.ok(p.message.length > 1200000);
      assert.ok(p.message.includes('Owner accepted: preserve this decision.'));
      console.log(JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'Draft for private review' }],
        meta: { agentMeta: { model: 'test', terminalReceipt: { successfulToolNames: [] } } } } }));
    `);
    const r = spawnSync(process.execPath, [new URL("../src/slack-planner-manual.js", import.meta.url).pathname, "--live"], {
      env: { ...process.env, OPENCLAW_WORKSPACE_DIR: dir, OPENCLAW_ENTRY: stub }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.shown_in_chat, true);
    assert.deepEqual(result.tools, []);
    assert.equal(fs.readFileSync(path.join(dir, "planner/tasks.md"), "utf8"), "Owner accepted: preserve this decision.");
    assert.equal(fs.readFileSync(result.draft, "utf8"), "Draft for private review");
    assert.equal(fs.statSync(result.draft).mode & 0o777, 0o600);
    assert.ok(!r.stdout.includes("Owner accepted"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
