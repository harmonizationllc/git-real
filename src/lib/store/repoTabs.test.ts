import { beforeEach, describe, expect, it } from "vitest";
import type { OpenedRepo } from "../ipc";
import { useRepoTabs } from "./repoTabs";

function repo(id: number, path = `/r/${id}`, headBranch: string | null = "main"): OpenedRepo {
  return { id, summary: { path, name: `r${id}`, headBranch, isBare: false } };
}

function openAll(...ids: number[]): void {
  for (const id of ids) useRepoTabs.getState().openTab(repo(id));
}

beforeEach(() => {
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
});

describe("initial state", () => {
  it("starts with no tabs and no active tab", () => {
    expect(useRepoTabs.getState().tabs).toEqual([]);
    expect(useRepoTabs.getState().activeId).toBeNull();
  });
});

// Contract: openTab appends+activates, or activates an existing tab (by id or path).
describe("openTab", () => {
  it("openTab appends and activates", () => {
    openAll(1, 2);
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(activeId).toBe(2);
  });

  it("openTab stores the summary on the new tab", () => {
    useRepoTabs.getState().openTab(repo(1));
    expect(useRepoTabs.getState().tabs[0]).toEqual({ id: 1, summary: repo(1).summary });
  });

  it("openTab with same path activates existing without duplicating", () => {
    openAll(1, 2);
    useRepoTabs.getState().openTab(repo(9, "/r/1"));
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(activeId).toBe(1);
  });

  it("openTab with same id activates existing without duplicating", () => {
    openAll(1, 2);
    useRepoTabs.getState().openTab(repo(1));
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs).toHaveLength(2);
    expect(activeId).toBe(1);
  });

  it("openTab of an existing repo refreshes its summary in place", () => {
    openAll(1, 2);
    const fresh = repo(1, "/r/1", "dev");
    useRepoTabs.getState().openTab(fresh);
    const { tabs } = useRepoTabs.getState();
    expect(tabs[0]).toEqual({ id: 1, summary: fresh.summary });
  });

  it("openTab with same path keeps the existing id and position", () => {
    openAll(1, 2);
    useRepoTabs.getState().openTab(repo(9, "/r/1", "dev"));
    const { tabs } = useRepoTabs.getState();
    expect(tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(tabs[0]?.summary.headBranch).toBe("dev");
  });

  it("openTab replaces the tabs array instead of mutating it", () => {
    openAll(1);
    const before = useRepoTabs.getState().tabs;
    useRepoTabs.getState().openTab(repo(2));
    expect(useRepoTabs.getState().tabs).not.toBe(before);
    expect(before).toHaveLength(1);
  });
});

// Contract: closeTab removes a tab and picks left, then right, then null as the new active tab.
describe("closeTab", () => {
  it("closeTab of middle active tab activates left neighbour", () => {
    openAll(1, 2, 3);
    useRepoTabs.getState().activate(2);
    useRepoTabs.getState().closeTab(2);
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs.map((t) => t.id)).toEqual([1, 3]);
    expect(activeId).toBe(1);
  });

  it("closeTab of first active tab activates right neighbour", () => {
    openAll(1, 2, 3);
    useRepoTabs.getState().activate(1);
    useRepoTabs.getState().closeTab(1);
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs.map((t) => t.id)).toEqual([2, 3]);
    expect(activeId).toBe(2);
  });

  it("closeTab of last active tab activates its left neighbour", () => {
    openAll(1, 2, 3);
    useRepoTabs.getState().closeTab(3);
    expect(useRepoTabs.getState().activeId).toBe(2);
  });

  it("closeTab last tab clears activeId", () => {
    openAll(1);
    useRepoTabs.getState().closeTab(1);
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs).toEqual([]);
    expect(activeId).toBeNull();
  });

  it("closeTab of inactive tab keeps activeId", () => {
    openAll(1, 2, 3);
    useRepoTabs.getState().closeTab(1);
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs.map((t) => t.id)).toEqual([2, 3]);
    expect(activeId).toBe(3);
  });

  it("closeTab of unknown id changes nothing", () => {
    openAll(1, 2);
    const before = useRepoTabs.getState();
    useRepoTabs.getState().closeTab(99);
    const after = useRepoTabs.getState();
    expect(after).toBe(before);
    expect(after.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(after.activeId).toBe(2);
  });

  it("closeTab on an empty store changes nothing", () => {
    const before = useRepoTabs.getState();
    useRepoTabs.getState().closeTab(1);
    expect(useRepoTabs.getState()).toBe(before);
  });
});

// Contract: activate(null) shows the start screen; unknown ids are ignored.
describe("activate", () => {
  it("activate(null) shows start screen", () => {
    openAll(1, 2);
    useRepoTabs.getState().activate(null);
    expect(useRepoTabs.getState().activeId).toBeNull();
  });

  it("activate(null) keeps the open tabs", () => {
    openAll(1, 2);
    useRepoTabs.getState().activate(null);
    expect(useRepoTabs.getState().tabs).toHaveLength(2);
  });

  it("activate switches to an existing tab", () => {
    openAll(1, 2);
    useRepoTabs.getState().activate(1);
    expect(useRepoTabs.getState().activeId).toBe(1);
  });

  it("activate of an unknown id is ignored", () => {
    openAll(1, 2);
    useRepoTabs.getState().activate(99);
    expect(useRepoTabs.getState().activeId).toBe(2);
  });

  it("activate of an unknown id on an empty store keeps activeId null", () => {
    useRepoTabs.getState().activate(5);
    expect(useRepoTabs.getState().activeId).toBeNull();
  });
});
