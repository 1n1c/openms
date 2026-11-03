import { expect, test } from "bun:test";
import { updateStatDetail } from "../src/ui/ui-stat.js";

test("Stat detail formats modern damage bounds from immutable server statistics", () => {
  const stats = Object.freeze({
    weaponType: 30,
    mastery: 0,
    pad: 17,
    str: 12,
    dex: 5,
    speed: 100,
  });
  const labels = new Map();
  const damage = { setAttribute: (key, value) => labels.set(key, value) };
  const speed = { setAttribute() {} };
  updateStatDetail({
    owner: { hooks: { characterStats: () => stats } },
    statDetail: {
      statValues: new Map([
        ["damage", damage],
        ["speed", speed],
      ]),
    },
  });
  expect(damage.textContent).toBe("1 ~ 9");
  expect(labels.get("aria-label")).toBe("damage: 1 ~ 9");
  expect(speed.textContent).toBe("100%");
  expect(Object.hasOwn(stats, "damageMin")).toBe(false);
});

test("modern large ranges fit the stat window while retaining exact accessible values", () => {
  const stats = Object.freeze({
    weaponType: 30,
    mastery: 0,
    str: 1000000,
    dex: 0,
    pad: 1000000,
  });
  const labels = new Map();
  const damage = { setAttribute: (key, value) => labels.set(key, value) };
  updateStatDetail({
    owner: { hooks: { characterStats: () => stats } },
    statDetail: { statValues: new Map([["damage", damage]]) },
  });
  expect(damage.textContent).toBe("4B ~ 40B");
  expect(labels.get("title")).toBe("4000000000 ~ 40000000000");
  expect(labels.get("aria-label")).toBe("damage: 4000000000 ~ 40000000000");
});
