import { describe, expect, it } from "vitest";
import type { RebaseCommit } from "../../../../lib/ipc";
import {
  ACTIONS,
  canStart,
  foldBlocked,
  initialPlan,
  move,
  setAction,
  summary,
  summaryText,
  toSteps,
} from "./plan";

const commit = (c: string, subject = `commit ${c}`): RebaseCommit => ({
  oid: c.repeat(40),
  subject,
  author: { name: "Ann", email: "ann@example.com", time: 1 },
});
// git order: a oldest … c newest
const commits = [commit("a"), commit("b"), commit("c")];
const order = (steps: { oid: string }[]) => steps.map((s) => s.oid[0]);

// Contract: the five actions are offered in the spec's order with the spec's labels.
describe("ACTIONS", () => {
  it("should list pick, squash, fixup, edit and drop in order", () => {
    expect(ACTIONS.map((a) => a.action)).toEqual(["pick", "squash", "fixup", "edit", "drop"]);
  });

  it("should carry the spec label for each action", () => {
    expect(ACTIONS.map((a) => a.label)).toEqual([
      "Pick — keep the commit",
      "Squash — fold into the commit below, keep both messages",
      "Fixup — fold into the commit below, discard its message",
      "Edit — stop after applying it to amend",
      "Drop — leave the commit out",
    ]);
  });
});

// Contract: the dialog lists newest first, every commit picked.
describe("initialPlan", () => {
  it("should list newest first with every action pick", () => {
    expect(initialPlan(commits).map((s) => [s.oid[0], s.action])).toEqual([
      ["c", "pick"],
      ["b", "pick"],
      ["a", "pick"],
    ]);
  });

  it("should keep the subject and author of each commit", () => {
    const [first] = initialPlan([commit("a", "Add the thing")]);
    expect(first).toEqual({
      oid: "a".repeat(40),
      subject: "Add the thing",
      author: { name: "Ann", email: "ann@example.com", time: 1 },
      action: "pick",
    });
  });

  it("should return an empty plan for no commits", () => {
    expect(initialPlan([])).toEqual([]);
  });

  it("should not reorder the input commits", () => {
    const input = [commit("a"), commit("b")];
    initialPlan(input);
    expect(order(input)).toEqual(["a", "b"]);
  });
});

// Contract: reorder by index, bounds-checked.
describe("move", () => {
  it("should move a step down one place", () => {
    expect(order(move(initialPlan(commits), 0, 1))).toEqual(["b", "c", "a"]);
  });

  it("should move a step to the end", () => {
    expect(order(move(initialPlan(commits), 0, 2))).toEqual(["b", "a", "c"]);
  });

  it("should move a step up one place", () => {
    expect(order(move(initialPlan(commits), 2, 1))).toEqual(["c", "a", "b"]);
  });

  it("should move a step to the start", () => {
    expect(order(move(initialPlan(commits), 2, 0))).toEqual(["a", "c", "b"]);
  });

  it("should return the same array for a target below zero", () => {
    const steps = initialPlan(commits);
    expect(move(steps, 0, -1)).toBe(steps);
  });

  it("should return the same array for a target past the end", () => {
    const steps = initialPlan(commits);
    expect(move(steps, 2, 3)).toBe(steps);
  });

  it("should return the same array when the target is the source", () => {
    const steps = initialPlan(commits);
    expect(move(steps, 1, 1)).toBe(steps);
  });

  it("should keep each step's action when it moves", () => {
    const steps = setAction(initialPlan(commits), 0, "drop");
    expect(move(steps, 0, 2).map((s) => [s.oid[0], s.action])).toEqual([
      ["b", "pick"],
      ["a", "pick"],
      ["c", "drop"],
    ]);
  });

  it("should not mutate the input", () => {
    const steps = initialPlan(commits);
    move(steps, 0, 2);
    expect(order(steps)).toEqual(["c", "b", "a"]);
  });
});

// Contract: one step's action changes, the rest are untouched.
describe("setAction", () => {
  it("should change one step's action and keep the others", () => {
    const next = setAction(initialPlan(commits), 1, "squash");
    expect(next.map((s) => s.action)).toEqual(["pick", "squash", "pick"]);
  });

  it("should not mutate the input", () => {
    const steps = initialPlan(commits);
    setAction(steps, 1, "drop");
    expect(steps.map((s) => s.action)).toEqual(["pick", "pick", "pick"]);
  });

  it("should leave the plan unchanged for an out-of-range index", () => {
    const next = setAction(initialPlan(commits), 7, "drop");
    expect(next.map((s) => s.action)).toEqual(["pick", "pick", "pick"]);
  });
});

// Contract: the oldest kept step cannot be squash or fixup; dropped steps never block.
describe("foldBlocked", () => {
  it("should block squash on the oldest step", () => {
    const steps = setAction(initialPlan(commits), 2, "squash");
    expect(foldBlocked(steps, 2)).toBe(true);
  });

  it("should not block the other steps when only the oldest folds", () => {
    const steps = setAction(initialPlan(commits), 2, "squash");
    expect(foldBlocked(steps, 0)).toBe(false);
  });

  it("should block fixup on the oldest step", () => {
    const steps = setAction(initialPlan(commits), 2, "fixup");
    expect(foldBlocked(steps, 2)).toBe(true);
  });

  it("should block fixup on the oldest kept step when older steps are dropped", () => {
    const steps = setAction(setAction(initialPlan(commits), 2, "drop"), 1, "fixup");
    expect(foldBlocked(steps, 1)).toBe(true);
  });

  it("should not block a squash with a kept step below it", () => {
    expect(foldBlocked(setAction(initialPlan(commits), 1, "squash"), 1)).toBe(false);
  });

  it("should not block a squash whose only older step is an edit", () => {
    const steps = setAction(setAction(initialPlan(commits), 2, "edit"), 1, "squash");
    expect(foldBlocked(steps, 1)).toBe(false);
  });

  it("should not block a dropped step", () => {
    expect(foldBlocked(setAction(initialPlan(commits), 2, "drop"), 2)).toBe(false);
  });

  it("should not block a picked oldest step", () => {
    expect(foldBlocked(initialPlan(commits), 2)).toBe(false);
  });

  it("should block a squash that becomes the oldest kept step after a move", () => {
    const steps = setAction(initialPlan(commits), 0, "squash");
    expect(foldBlocked(steps, 0)).toBe(false);
    const moved = move(steps, 0, 2);
    expect(foldBlocked(moved, 2)).toBe(true);
  });
});

// Contract: the footer counts kept, squashed (squash + fixup) and dropped steps.
describe("summary", () => {
  it("should count kept, squashed and dropped", () => {
    const steps = setAction(setAction(initialPlan(commits), 0, "squash"), 2, "drop");
    expect(summary(steps)).toEqual({ kept: 1, squashed: 1, dropped: 1 });
  });

  it("should count an edit as kept", () => {
    const steps = setAction(initialPlan(commits), 1, "edit");
    expect(summary(steps)).toEqual({ kept: 3, squashed: 0, dropped: 0 });
  });

  it("should count fixup as squashed", () => {
    const steps = setAction(initialPlan(commits), 0, "fixup");
    expect(summary(steps)).toEqual({ kept: 2, squashed: 1, dropped: 0 });
  });

  it("should count nothing for an empty plan", () => {
    expect(summary([])).toEqual({ kept: 0, squashed: 0, dropped: 0 });
  });
});

// Contract: footer copy, with singular forms for exactly one.
describe("summaryText", () => {
  it("should use plurals", () => {
    expect(summaryText({ kept: 3, squashed: 2, dropped: 0 })).toBe(
      "3 commits, 2 squashed, 0 dropped",
    );
  });

  it("should use singulars", () => {
    expect(summaryText({ kept: 1, squashed: 1, dropped: 1 })).toBe(
      "1 commit, 1 squashed, 1 dropped",
    );
  });

  it("should use the plural commits for zero", () => {
    expect(summaryText({ kept: 0, squashed: 0, dropped: 2 })).toBe(
      "0 commits, 0 squashed, 2 dropped",
    );
  });
});

// Contract: the IPC wants git's order, oldest first, with only action and oid.
describe("toSteps", () => {
  it("should emit oldest first with actions", () => {
    const steps = setAction(initialPlan(commits), 0, "drop");
    expect(toSteps(steps)).toEqual([
      { action: "pick", oid: "a".repeat(40) },
      { action: "pick", oid: "b".repeat(40) },
      { action: "drop", oid: "c".repeat(40) },
    ]);
  });

  it("should follow a reordered plan", () => {
    const steps = move(initialPlan(commits), 0, 2);
    expect(toSteps(steps).map((s) => s.oid[0])).toEqual(["c", "a", "b"]);
  });

  it("should emit nothing for an empty plan", () => {
    expect(toSteps([])).toEqual([]);
  });

  it("should not mutate the input", () => {
    const steps = initialPlan(commits);
    toSteps(steps);
    expect(order(steps)).toEqual(["c", "b", "a"]);
  });
});

// Contract: Start needs at least one kept step and no blocked fold.
describe("canStart", () => {
  it("should be true for the initial plan", () => {
    expect(canStart(initialPlan(commits))).toBe(true);
  });

  it("should be false when everything is dropped", () => {
    const all = commits.reduce((s, _c, i) => setAction(s, i, "drop"), initialPlan(commits));
    expect(canStart(all)).toBe(false);
  });

  it("should be false with a blocked fold", () => {
    expect(canStart(setAction(initialPlan(commits), 2, "squash"))).toBe(false);
  });

  it("should be true once the blocked fold has a kept step below it", () => {
    const steps = setAction(initialPlan(commits), 1, "squash");
    expect(canStart(steps)).toBe(true);
  });

  it("should be false for an empty plan", () => {
    expect(canStart([])).toBe(false);
  });
});
