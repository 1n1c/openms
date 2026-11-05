import { expect, test } from "bun:test";
import { retainAttackInput, takeAttackInput } from "../src/attack-input.js";

function actor() {
  return { field: { tick: 100 }, attackEdges: [], receivedAttack: false };
}
function sample(attack, inputSeq, targetTick = 80) {
  return { attack, inputSeq, targetTick };
}

test("an expired movement sample preserves one attack through a bunched press/release", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1));
  retainAttackInput(a, sample(true, 2));
  retainAttackInput(a, sample(false, 3));
  expect(takeAttackInput(a)).toBe(false);
  a.field.tick++;
  expect(takeAttackInput(a)).toBe(true);
  expect(a.combatInputSeq).toBe(1);
  expect(takeAttackInput(a)).toBe(false);
});

test("future, ancient, overloaded and expired attack edges have explicit bounds", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1, 1000));
  retainAttackInput(a, sample(false, 2));
  retainAttackInput(a, sample(true, 3, 1));
  expect(a.attackEdges).toHaveLength(0);
  // receivedAttack resets only on a matching release; insert one before next press.
  retainAttackInput(a, sample(false, 3));
  expect(retainAttackInput(a, sample(true, 4))).toBe(true);
  // MAX_EDGES=1 — overflow silently drops the newest edge, no throw.
  expect(retainAttackInput(a, sample(true, 5))).toBe(false);
  expect(a.attackEdges).toHaveLength(1);
  a.field.tick = 1000;
  expect(takeAttackInput(a)).toBe(false);
});

test("queued attacks survive an active animation but their age never resets", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1, 99));
  retainAttackInput(a, sample(false, 2, 100));
  // MAX_EDGES=1 — second press is silently dropped during active queue.
  expect(retainAttackInput(a, sample(true, 3, 101))).toBe(false);
  a.field.tick = 110;
  expect(takeAttackInput(a, false)).toBe(false);
  expect(a.attackEdges).toHaveLength(1);
  expect(takeAttackInput(a, true)).toBe(true);
  expect(a.combatInputSeq).toBe(1);
  a.field.tick = 169;
  expect(takeAttackInput(a, true)).toBe(false);
  expect(a.attackEdges).toHaveLength(0);
});
