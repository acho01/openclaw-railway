import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const middleware = source.slice(source.indexOf("function requireDashboardAuth("), source.indexOf("// --- Gateway token injection ---"));
const authenticate = vm.runInNewContext(`(${middleware.trim()})`, {
  Buffer, crypto, SETUP_PASSWORD: "setup-secret", OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
});
function check(authorization) {
  const result = { passed: false, status: null, challenge: null };
  const response = {
    set(_name, value) { result.challenge = value; return this; },
    status(value) { result.status = value; return this; },
    send() { return this; }, json() { return this; },
  };
  authenticate({ path: "/api/test", headers: { authorization } }, response, () => { result.passed = true; });
  return result;
}
test("dashboard accepts the exact gateway bearer token", () => {
  assert.equal(check("Bearer gateway-secret").passed, true);
});
test("invalid bearer tokens cannot bypass auth and do not trigger a Basic popup", () => {
  for (const value of ["Bearer wrong", "Bearer gateway-secrex", "Bearer"]) {
    const result = check(value);
    assert.equal(result.passed, false);
    assert.equal(result.status, 401);
    assert.equal(result.challenge, null);
  }
});
test("dashboard still checks Basic passwords and challenges unauthenticated navigation", () => {
  assert.equal(check(`Basic ${Buffer.from("admin:setup-secret").toString("base64")}`).passed, true);
  assert.equal(check(`Basic ${Buffer.from("admin:wrong").toString("base64")}`).status, 401);
  assert.match(check("").challenge, /Basic/);
});
