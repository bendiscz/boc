import assert from "node:assert/strict";
import test from "node:test";
import { formatCredits, parseCredits } from "../src/budget/credits.ts";

test("credit decimals are exact even beyond Number precision", () => {
  assert.equal(parseCredits("0.1") + parseCredits("0.2"), parseCredits("0.3"));
  assert.equal(
    formatCredits(parseCredits("9007199254740993.000000000000000001")),
    "9007199254740993.000000000000000001",
  );
  assert.ok(parseCredits("0.000000000000000001") > parseCredits("0"));
});

test("credit formatting is canonical and round-trips", () => {
  for (const [input, expected] of [
    ["0", "0"],
    ["0.000", "0"],
    ["12.3400", "12.34"],
    ["999999999999999999.999999999999999999", "999999999999999999.999999999999999999"],
  ]) {
    assert.equal(formatCredits(parseCredits(input ?? "")), expected);
  }
});

test("invalid or over-precision credit values fail rather than round", () => {
  for (const value of [
    "",
    "-1",
    "+1",
    "01",
    ".5",
    "1.",
    "1e3",
    "NaN",
    "Infinity",
    " 1",
    "1\n",
    "1000000000000000000",
    "0.0000000000000000001",
  ]) {
    assert.throws(() => parseCredits(value));
  }
});
