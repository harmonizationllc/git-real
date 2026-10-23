import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFS_DEFAULT, SIDEBAR_DEFAULT, useLayoutPrefs } from "./layoutPrefs";

beforeEach(() => {
  localStorage.clear();
  useLayoutPrefs.setState({
    refsWidth: 240,
    sidebarWidth: 320,
    tagsCollapsed: true,
    pullRequestsCollapsed: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Contract: column widths default to 240/320, can be set and reset, persist and rehydrate.
describe("useLayoutPrefs", () => {
  it("should default to a 240px refs column and a 320px sidebar", () => {
    expect(useLayoutPrefs.getInitialState()).toMatchObject({ refsWidth: 240, sidebarWidth: 320 });
  });

  it("should export the defaults 240 and 320", () => {
    expect([REFS_DEFAULT, SIDEBAR_DEFAULT]).toEqual([240, 320]);
  });

  it("should update refsWidth when setRefsWidth is called", () => {
    useLayoutPrefs.getState().setRefsWidth(200);
    expect(useLayoutPrefs.getState().refsWidth).toBe(200);
  });

  it("should leave sidebarWidth alone when setRefsWidth is called", () => {
    useLayoutPrefs.getState().setRefsWidth(200);
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(320);
  });

  it("should update sidebarWidth when setSidebarWidth is called", () => {
    useLayoutPrefs.getState().setSidebarWidth(400);
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(400);
  });

  it("should leave refsWidth alone when setSidebarWidth is called", () => {
    useLayoutPrefs.getState().setSidebarWidth(400);
    expect(useLayoutPrefs.getState().refsWidth).toBe(240);
  });

  it("should restore the refs default when reset('refs') is called", () => {
    useLayoutPrefs.setState({ refsWidth: 180, sidebarWidth: 400 });
    useLayoutPrefs.getState().reset("refs");
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 240, sidebarWidth: 400 });
  });

  it("should restore the sidebar default when reset('sidebar') is called", () => {
    useLayoutPrefs.setState({ refsWidth: 180, sidebarWidth: 400 });
    useLayoutPrefs.getState().reset("sidebar");
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 180, sidebarWidth: 320 });
  });

  it("should persist under the git-real.layoutPrefs key", () => {
    useLayoutPrefs.getState().setRefsWidth(200);
    const raw = localStorage.getItem("git-real.layoutPrefs");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state).toMatchObject({ refsWidth: 200 });
  });

  it("should use git-real.layoutPrefs as its persist name", () => {
    expect(useLayoutPrefs.persist.getOptions().name).toBe("git-real.layoutPrefs");
  });

  it("should persist the widths and both collapse flags, not the setters", () => {
    useLayoutPrefs.getState().setSidebarWidth(400);
    const raw = localStorage.getItem("git-real.layoutPrefs") as string;
    expect(Object.keys(JSON.parse(raw).state).sort()).toEqual([
      "pullRequestsCollapsed",
      "refsWidth",
      "sidebarWidth",
      "tagsCollapsed",
    ]);
  });

  it("should rehydrate from storage", async () => {
    localStorage.setItem(
      "git-real.layoutPrefs",
      JSON.stringify({ state: { refsWidth: 180, sidebarWidth: 410 }, version: 0 }),
    );
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 180, sidebarWidth: 410 });
  });

  it("should still update in memory when localStorage rejects writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    expect(() => useLayoutPrefs.getState().setRefsWidth(200)).not.toThrow();
    expect(useLayoutPrefs.getState().refsWidth).toBe(200);
  });

  it("should keep the defaults when rehydrating from corrupt storage", async () => {
    localStorage.setItem("git-real.layoutPrefs", "{not json");
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 240, sidebarWidth: 320 });
  });
});

// Coverage audit: rehydration pins current behaviour for out-of-range and non-numeric values.
// The store does not validate; clampWidths floors numbers and RepoPane must tolerate the rest.
describe("useLayoutPrefs rehydration of unexpected values", () => {
  const store = (state: unknown) =>
    localStorage.setItem("git-real.layoutPrefs", JSON.stringify({ state, version: 0 }));

  it("should pass through a stored width below the column minimum (clamping is the layout's job)", async () => {
    store({ refsWidth: 10, sidebarWidth: 20 });
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 10, sidebarWidth: 20 });
  });

  it("should pass a stored null through unchanged (current behaviour)", async () => {
    store({ refsWidth: null, sidebarWidth: 410 });
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: null, sidebarWidth: 410 });
  });

  it("should pass a stored non-number through unchanged (current behaviour)", async () => {
    store({ refsWidth: "wide", sidebarWidth: 410 });
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState().refsWidth).toBe("wide");
  });

  it("should keep a default for a width missing from storage", async () => {
    store({ refsWidth: 200 });
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 200, sidebarWidth: 320 });
  });

  it("should keep the setters working after rehydrating", async () => {
    store({ refsWidth: 200, sidebarWidth: 410 });
    await useLayoutPrefs.persist.rehydrate();
    useLayoutPrefs.getState().reset("refs");
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 240, sidebarWidth: 410 });
  });

  it("should rehydrate empty storage as the defaults", async () => {
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 240, sidebarWidth: 320 });
  });
});

// Contract (GR-11b): the Tags section starts collapsed and the flag persists beside the widths.
describe("useLayoutPrefs tagsCollapsed", () => {
  it("should start with tags collapsed", () => {
    expect(useLayoutPrefs.getInitialState().tagsCollapsed).toBe(true);
  });

  it("should expand when setTagsCollapsed(false) is called", () => {
    useLayoutPrefs.getState().setTagsCollapsed(false);
    expect(useLayoutPrefs.getState().tagsCollapsed).toBe(false);
  });

  it("should collapse again when setTagsCollapsed(true) is called", () => {
    useLayoutPrefs.getState().setTagsCollapsed(false);
    useLayoutPrefs.getState().setTagsCollapsed(true);
    expect(useLayoutPrefs.getState().tagsCollapsed).toBe(true);
  });

  it("should leave the widths alone when setTagsCollapsed is called", () => {
    useLayoutPrefs.getState().setTagsCollapsed(false);
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 240, sidebarWidth: 320 });
  });

  it("should store and persist the flag", () => {
    useLayoutPrefs.getState().setTagsCollapsed(false);
    const raw = localStorage.getItem("git-real.layoutPrefs") as string;
    expect(JSON.parse(raw).state.tagsCollapsed).toBe(false);
  });

  it("should rehydrate a stored flag", async () => {
    localStorage.setItem(
      "git-real.layoutPrefs",
      JSON.stringify({
        state: { refsWidth: 200, sidebarWidth: 300, tagsCollapsed: false },
        version: 0,
      }),
    );
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState().tagsCollapsed).toBe(false);
  });

  it("should keep tags collapsed when restoring a state saved before tagsCollapsed existed", async () => {
    localStorage.setItem(
      "git-real.layoutPrefs",
      JSON.stringify({ state: { refsWidth: 200, sidebarWidth: 300 }, version: 0 }),
    );
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState()).toMatchObject({ refsWidth: 200, tagsCollapsed: true });
  });

  it("should leave tagsCollapsed alone on reset", () => {
    useLayoutPrefs.setState({ refsWidth: 180, tagsCollapsed: false });
    useLayoutPrefs.getState().reset("refs");
    expect(useLayoutPrefs.getState().tagsCollapsed).toBe(false);
  });
});

// Contract (GR-13a): the Pull requests section starts expanded and the flag persists beside the widths.
describe("useLayoutPrefs pullRequestsCollapsed", () => {
  it("should start with pull requests expanded", () => {
    expect(useLayoutPrefs.getInitialState().pullRequestsCollapsed).toBe(false);
  });

  it("should collapse when setPullRequestsCollapsed(true) is called", () => {
    useLayoutPrefs.getState().setPullRequestsCollapsed(true);
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(true);
  });

  it("should expand again when setPullRequestsCollapsed(false) is called", () => {
    useLayoutPrefs.getState().setPullRequestsCollapsed(true);
    useLayoutPrefs.getState().setPullRequestsCollapsed(false);
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(false);
  });

  it("should leave tagsCollapsed and the widths alone when toggled", () => {
    useLayoutPrefs.getState().setPullRequestsCollapsed(true);
    expect(useLayoutPrefs.getState()).toMatchObject({
      refsWidth: 240,
      sidebarWidth: 320,
      tagsCollapsed: true,
    });
  });

  it("should store and persist the flag", () => {
    useLayoutPrefs.getState().setPullRequestsCollapsed(true);
    const raw = localStorage.getItem("git-real.layoutPrefs") as string;
    expect(JSON.parse(raw).state.pullRequestsCollapsed).toBe(true);
  });

  it("should rehydrate a stored flag", async () => {
    localStorage.setItem(
      "git-real.layoutPrefs",
      JSON.stringify({
        state: { refsWidth: 200, sidebarWidth: 300, pullRequestsCollapsed: true },
        version: 0,
      }),
    );
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(true);
  });

  it("should keep pull requests expanded when restoring a state saved before the flag existed", async () => {
    localStorage.setItem(
      "git-real.layoutPrefs",
      JSON.stringify({ state: { refsWidth: 200, sidebarWidth: 300 }, version: 0 }),
    );
    await useLayoutPrefs.persist.rehydrate();
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(false);
  });

  it("should leave pullRequestsCollapsed alone on reset", () => {
    useLayoutPrefs.setState({ refsWidth: 180, pullRequestsCollapsed: true });
    useLayoutPrefs.getState().reset("refs");
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(true);
  });
});
