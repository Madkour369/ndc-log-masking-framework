// CLI parsing self-test:  npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { cli, sanitizeArgv } from "./cli";

test("normal flags map correctly", () => {
  const { args, warnings, errors } = cli(["--only", "AJet,Air Cairo", "--headed", "--open", "--stop-after", "fareConfirm"]);
  assert.equal(args.only, "AJet,Air Cairo");
  assert.equal(args.headed, true);
  assert.equal(args.open, true);
  assert.equal(args["stop-after"], "fareConfirm");
  assert.deepEqual([warnings, errors], [[], []]);
});

test("trailing backslashes / slashes / whitespace from shell line continuation are stripped", () => {
  assert.deepEqual(sanitizeArgv(["--only", "AJet\\", "--headed\\", " --open/ ", "\\", "/"]), ["--only", "AJet", "--headed", "--open"]);
  const { args, warnings, errors } = cli(["--only", "AJet", "--headed\\", "--open\\", "\\"]);
  assert.equal(args.headed, true);
  assert.equal(args.open, true);
  assert.deepEqual([warnings, errors], [[], []]);
});

test("--option=value form and defaults", () => {
  const { args } = cli(["--only=AJet", "--validate-at=end"]);
  assert.equal(args.only, "AJet");
  assert.equal(args["validate-at"], "end");
  assert.equal(args.config, "config.json");
  assert.equal(args.headed, false);
});

test("unknown flags and stray arguments warn instead of throwing", () => {
  const { args, warnings, errors } = cli(["--head", "--opne", "--foo", "stray", "--open"]);
  assert.equal(args.open, true);
  assert.equal(args.headed, false);
  assert.deepEqual(errors, []);
  assert.match(warnings.join("\n"), /--head ignored \(did you mean --headed\?\)/);
  assert.match(warnings.join("\n"), /--opne ignored \(did you mean --open\?\)/);
  assert.match(warnings.join("\n"), /--foo ignored/);
  assert.match(warnings.join("\n"), /extra argument\(s\) ignored: "stray"/);
});

test("a value option without a value is a clear error, not a crash", () => {
  const { errors } = cli(["--headed", "--only"]);
  assert.match(errors[0], /--only needs a value/);
});
