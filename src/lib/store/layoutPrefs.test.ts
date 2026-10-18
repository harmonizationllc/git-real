import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutPrefs } from "./layoutPrefs";

beforeEach(() => {
  localStorage.clear();
  useLayoutPrefs.setState({ refsWidth: 240, sidebarWidth: 320 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Contract: column widths default to 240/320, can be set and reset, persist and rehydrate.
describe("useLayoutPrefs", () => {
  it("should default to a 240px refs column and a 320px sidebar", () => {
    expect(useLayoutPrefs.getInitialState()).toMatchObject({ refsWidth: 240, sidebarWidth: 320 });
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

  it("should persist only the widths, not the setters", () => {
    useLayoutPrefs.getState().setSidebarWidth(400);
    const raw = localStorage.getItem("git-real.layoutPrefs") as string;
    expect(Object.keys(JSON.parse(raw).state).sort()).toEqual(["refsWidth", "sidebarWidth"]);
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
