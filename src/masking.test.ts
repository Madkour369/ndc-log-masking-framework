// Scanner self-test with synthetic data only:  npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createScanner, LeakScanner, valueKind } from "./masking";
import { reapplyMaskingRules } from "./report";
import type { SupplierResult } from "./types";

const scanner = new LeakScanner({
  keys: ["password", "username", "token", "authorization", "apiKey", "x-api-key", "signature", "sig"],
  patterns: ["username", "password", "secret", "token", "authorization", "apikey", "signature"],
  ignore: ["type", "expir"],
  secrets: ["S3cretValue!"],
});

test("masked XML credentials pass", () => {
  const xml = "<wsse:UsernameToken><wsse:Username>********</wsse:Username><wsse:Password Type=\"x\">********</wsse:Password></wsse:UsernameToken>";
  assert.deepEqual(scanner.scan({ body: xml }), []);
});

test("plain XML credentials inside double-encoded log body fail", () => {
  const inner = JSON.stringify("<Security><Username>agent01</Username><Password>pw-123</Password></Security>");
  const body = JSON.stringify({ context: { request: inner } });
  const findings = scanner.scan({ body });
  assert.deepEqual(findings.map((f) => f.key).sort(), ["Password", "Username"]);
  assert.ok(findings.every((f) => !f.evidence.includes("pw-123") && !f.evidence.includes("agent01")));
});

test("structured JSON field and Bearer token fail, masked ones pass", () => {
  const findings = scanner.scan({ apiKey: "abcd1234", password: "********", headers: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x" });
  assert.deepEqual(findings.map((f) => f.rule).sort(), ["header-line", "structured-field"]);
});

test("known secret value is found anywhere", () => {
  assert.equal(scanner.scan({ message: "connecting with S3cretValue! to supplier" })[0]?.rule, "known-secret");
});

test("query strings and empty values", () => {
  assert.equal(scanner.scan("https://x/api?username=bob&password=").length, 1);
  assert.equal(scanner.scan("https://x/api?username=********&password=********").length, 0);
});

test("target key spellings: userName / User-Name / passWord / Pass-Word / authToken / x-api-key / digitalSignature / sig", () => {
  const doc = {
    userName: "u1", "User-Name": "u2", passWord: "p1", "Pass-Word": "p2", authToken: "t1",
    "x-api-key": "k1", digitalSignature: "s1", sig: "s2", clientSecret: "c1",
  };
  assert.equal(scanner.scan(doc).length, 9);
});

test("containing match flags compound keys, ignore list skips metadata", () => {
  assert.equal(scanner.scan({ agentUserName: "bob", "X-Auth-Token": "abc123" }).length, 2);
  assert.equal(scanner.scan({ tokenType: "Bearer", passwordExpiry: "2027-01-01", consignee: "ACME" }).length, 0);
});

test("strict masking: only asterisks pass; partial masks fail", () => {
  assert.equal(scanner.scan({ password: "********" }).length, 0);
  const [partial] = scanner.scan({ password: "ab****yz" });
  assert.equal(partial.kind, "partially masked");
});

test("value kinds describe the exposure without revealing it", () => {
  assert.equal(valueKind("Basic dXNlcjpwYXNz"), "Basic credential");
  assert.equal(valueKind("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), "JWT");
  assert.equal(valueKind("hunter2"), "plain text");
});

// ---- spec field list, loaded from the real config.json so the test fails if a field is removed there
import { readFileSync } from "node:fs";
import type { Config } from "./types";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as Config;
const spec = createScanner({ ...cfg.masking, known_secrets_env: "__NONE__", known_secrets_file: undefined }, ".");

test("every spec field is a target, in camelCase, snake_case and hyphen spellings", () => {
  const fields = ["AuthorizedBy", "Nonce", "client_secret", "clientSecret", "access_token", "accessToken", "refresh_token",
    "id_token", "apiKey", "api_key", "api-key", "secretKey", "secret_key", "cardNumber", "card_number", "cvv", "cvc",
    "expiryDate", "expiry_date", "cardHolder", "card-holder"];
  for (const field of fields) assert.equal(spec.scan({ [field]: "plain-value" }).length, 1, `${field} should be a target`);
});

test("dotted spec paths: data.token, credentials.username, credentials.password", () => {
  const doc = { data: { token: "abc" }, credentials: { username: "agent", password: "pw" } };
  assert.deepEqual(spec.scan(doc).map((f) => f.key).sort(), ["password", "token", "username"]);
});

test("payment containers: every value inside paymentFields / UniversalRecord.card must be masked", () => {
  const book = {
    paymentFields: { number: "4111111111111111", holder: "JOHN TESTER", exp: "12/28", code: "********" },
    UniversalRecord: { card: { pan: "5500000000000004" } },
    card: { pan: "not inside UniversalRecord - only cardNumber-like keys count here" },
  };
  const keys = spec.scan(book).map((f) => f.key).sort();
  assert.deepEqual(keys, ["UniversalRecord.card.pan", "paymentFields.exp", "paymentFields.holder", "paymentFields.number"]);
});

test("[VERIFIED MASKED] occurrences are reported with counts; exposures still fail", () => {
  const { findings, verified } = spec.scanAll({
    access_token: "********",
    logs: ["<Password>********</Password>", "<Password>********</Password>"],
    Nonce: "abc123",
  });
  assert.deepEqual(findings.map((f) => f.key), ["Nonce"]);
  assert.deepEqual(verified.map((v) => [v.key, v.value, v.count]).sort(), [["Password", "********", 2], ["access_token", "********", 1]]);
});

// ---- exclusions and step-scoped rules (from config.json)
const STEPS = ["search", "fareConfirm", "addPassengerDetails", "book"];

test("excluded fields are never asserted in any step: Authorization, HostToken, HostTokenRef, userId, HistoricUserName", () => {
  const doc = {
    Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
    headers: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    body: "<HostToken HostTokenRef=\"t1:abc123\">GFB10101ADT00</HostToken>",
    userId: "api.ndc.user", HistoricUserName: "api.ndc.user",
    masked: { Authorization: "********", userId: "***" },
  };
  for (const step of [...STEPS, undefined]) {
    const r = spec.scanAll(doc, { step });
    assert.deepEqual([r.findings, r.verified], [[], []], `step ${step}`);
  }
});

test("excluding those fields does not weaken the others", () => {
  const r = spec.scanAll({ userId: "u1", password: "plain", apiKey: "********" }, { step: "book" });
  assert.deepEqual(r.findings.map((f) => f.key), ["password"]);
  assert.deepEqual(r.verified.map((v) => v.key), ["apiKey"]);
});

test("ExpiryDate is asserted only in Book (offer expiry in Search / FareConfirm is ignored)", () => {
  const offer = { ExpiryDate: "2026-10-20T10:00:00Z" };
  for (const step of ["search", "fareConfirm", "addPassengerDetails"]) assert.equal(spec.scanAll(offer, { step }).findings.length, 0, step);
  assert.equal(spec.scanAll({ ExpiryDate: "12/28" }, { step: "book" }).findings[0]?.key, "ExpiryDate");
  assert.equal(spec.scanAll({ ExpiryDate: "*****" }, { step: "book" }).verified[0]?.key, "ExpiryDate");
  assert.equal(spec.scanAll("<ExpiryDate>1228</ExpiryDate>", { step: "BOOK" }).findings.length, 1, "step match is case-insensitive");
});

test("re-applying the rules to a saved report drops excluded findings and turns the check to PASS", () => {
  const finding = (key: string, rule = "json-text") => ({ rule, key, location: "$", evidence: "xx****** (9 chars)" });
  const sup = {
    supplier: "X", overall: "FAIL", overall_reason: null, flow_status: "PASS", failed_step: null, error: null, duration_ms: 0,
    masking_verdict: "FAIL",
    steps: [{ step: "fareConfirm", status: "PASS", response_exposure: [finding("ExpiryDate")], response_verified: [] }],
    masking: [{ step: "fareConfirm", verdict: "FAIL", hits: 3, findings: [finding("Authorization"), finding("Bearer", "auth-scheme"), finding("HostToken")], verified: [], error: null, kql: null }],
  } as unknown as SupplierResult;
  assert.deepEqual(reapplyMaskingRules([sup], spec), { findings: 4, verified: 0 });
  assert.equal(sup.masking[0].verdict, "PASS");
  assert.equal(sup.steps[0].response_exposure.length, 0);
});
