import { describe, expect, it } from "vitest";
import { rankCommands } from "./index";
import type { Rankable, Ranked } from "./index";

// Contract: rankCommands scores items and returns Ranked<T> structs.

interface Item extends Rankable {
  id: string;
}

const item = (id: string, label: string, detail?: string): Item => ({
  id,
  label,
  detail,
});

// Contract: blank query keeps order and marks nothing matched.
describe("rankCommands blank query", () => {
  it("blank query keeps order and marks nothing matched", () => {
    const items = [item("a", "Fetch"), item("b", "Pull"), item("c", "Push")];
    const result = rankCommands("", items);
    expect(result.map((r) => r.item.id)).toEqual(["a", "b", "c"]);
    expect(result.every((r) => r.matched === null)).toBe(true);
  });

  it("blank query returns all items", () => {
    const items = [item("a", "A"), item("b", "B")];
    expect(rankCommands("", items)).toHaveLength(2);
  });
});

// Contract: matches on label before detail.
describe("rankCommands label vs detail matching", () => {
  it("matches on label before detail", () => {
    const items = [item("detail-match", "Something", "fetch"), item("label-match", "fetch all")];
    const result = rankCommands("fetch", items);
    // label-match should rank before detail-match.
    const ids = result.map((r) => r.item.id);
    expect(ids.indexOf("label-match")).toBeLessThan(ids.indexOf("detail-match"));
  });

  it("marks matched as label when label matches", () => {
    const items = [item("a", "Fetch")];
    const result = rankCommands("fetch", items);
    expect(result[0]?.matched).toBe("label");
  });

  it("marks matched as detail when only detail matches", () => {
    const items = [item("a", "Something", "fetch this")];
    const result = rankCommands("fetch", items);
    expect(result[0]?.matched).toBe("detail");
  });
});

// Contract: orders by score then input order (stable).
describe("rankCommands ordering", () => {
  it("orders by score then input order (stable)", () => {
    // "ab" matches "ab" (span 2) and "a...b" (larger span).
    const items = [item("long", "a long b string"), item("short", "ab")];
    const result = rankCommands("ab", items);
    expect(result[0]?.item.id).toBe("short");
  });

  it("stable by input order for same-score items", () => {
    const items = [item("x", "abc"), item("y", "abc")];
    const result = rankCommands("a", items);
    expect(result.map((r) => r.item.id)).toEqual(["x", "y"]);
  });
});

// Contract: drops non-matching rows.
describe("rankCommands non-matching", () => {
  it("drops non-matching rows", () => {
    const items = [item("a", "Fetch"), item("b", "Clone"), item("c", "Push")];
    const result = rankCommands("clone", items);
    expect(result).toHaveLength(1);
    expect(result[0]?.item.id).toBe("b");
  });

  it("returns empty array when nothing matches", () => {
    const items = [item("a", "Fetch")];
    expect(rankCommands("zzz", items)).toHaveLength(0);
  });
});

// Contract: case-insensitive.
describe("rankCommands case insensitive", () => {
  it("is case-insensitive", () => {
    const items = [item("a", "FETCH")];
    const result = rankCommands("fetch", items);
    expect(result).toHaveLength(1);
    expect(result[0]?.item.id).toBe("a");
  });
});
