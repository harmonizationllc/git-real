// GR-29 Task 5: the thin named setters over the settings store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../ipc";
import { resetSettings } from "../../test/settingsStore";
import { DEFAULT_SETTINGS, useSettings } from "./settings";
import * as actions from "./settingsActions";

vi.mock(import("../ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const sent = vi.mocked(updateSettings);

beforeEach(async () => {
  sent.mockReset();
  await resetSettings();
  vi.useFakeTimers();
});

afterEach(async () => {
  await useSettings.getState().flush();
  vi.useRealTimers();
});

const settings = () => useSettings.getState().settings;

/** Flushes and returns the patches sent to the backend. */
async function patches() {
  await useSettings.getState().flush();
  return sent.mock.calls.map(([p]) => p);
}

describe("appearance setters", () => {
  it("setTheme sets the theme", async () => {
    actions.setTheme("dark");
    expect(settings().appearance.theme).toBe("dark");
    expect(await patches()).toEqual([{ appearance: { theme: "dark" } }]);
  });

  it("setDiffFontSize clamps 9→10, 25→24, rounds 13.6→14, ignores NaN", async () => {
    actions.setDiffFontSize(9);
    expect(settings().appearance.diffFontSize).toBe(10);
    actions.setDiffFontSize(25);
    expect(settings().appearance.diffFontSize).toBe(24);
    actions.setDiffFontSize(13.6);
    expect(settings().appearance.diffFontSize).toBe(14);
    actions.setDiffFontSize(Number.NaN);
    expect(settings().appearance.diffFontSize).toBe(14);
    expect(await patches()).toEqual([{ appearance: { diffFontSize: 14 } }]);
  });

  it("setDiffFontSize with only NaN sends nothing", async () => {
    actions.setDiffFontSize(Number.NaN);
    expect(settings()).toEqual(DEFAULT_SETTINGS);
    expect(await patches()).toEqual([]);
  });

  it('setDiffFontFamily maps "" and "  " to null and trims', async () => {
    actions.setDiffFontFamily("  Fira Code  ");
    expect(settings().appearance.diffFontFamily).toBe("Fira Code");
    actions.setDiffFontFamily("");
    expect(settings().appearance.diffFontFamily).toBeNull();
    actions.setDiffFontFamily("Mono");
    actions.setDiffFontFamily("  ");
    expect(settings().appearance.diffFontFamily).toBeNull();
    actions.setDiffFontFamily(null);
    expect(settings().appearance.diffFontFamily).toBeNull();
    expect(await patches()).toEqual([{ appearance: { diffFontFamily: null } }]);
  });
});

describe("diff setters", () => {
  it("setDiffMode and setIgnoreWhitespace set the diff section", async () => {
    actions.setDiffMode("unified");
    actions.setIgnoreWhitespace(true);
    expect(settings().diff).toEqual({ mode: "unified", ignoreWhitespace: true });
    expect(await patches()).toEqual([{ diff: { mode: "unified", ignoreWhitespace: true } }]);
  });
});

describe("layout setters", () => {
  it("setRefsWidth and setSidebarWidth set the widths", async () => {
    actions.setRefsWidth(300);
    actions.setSidebarWidth(410);
    expect(settings().layout).toMatchObject({ refsWidth: 300, sidebarWidth: 410 });
    expect(await patches()).toEqual([{ layout: { refsWidth: 300, sidebarWidth: 410 } }]);
  });

  it("setRefsWidth rounds fractional widths", async () => {
    actions.setRefsWidth(240.6);
    expect(await patches()).toEqual([{ layout: { refsWidth: 241 } }]);
  });

  it("setSidebarWidth rounds fractional widths", async () => {
    actions.setSidebarWidth(320.4);
    expect(await patches()).toEqual([{ layout: { sidebarWidth: 320 } }]);
  });

  it("resetWidth restores 240 / 320", async () => {
    actions.setRefsWidth(300);
    actions.setSidebarWidth(410);
    actions.resetWidth("refs");
    expect(settings().layout.refsWidth).toBe(240);
    expect(settings().layout.sidebarWidth).toBe(410);
    actions.resetWidth("sidebar");
    expect(settings().layout.sidebarWidth).toBe(320);
    expect(await patches()).toEqual([{ layout: { refsWidth: 240, sidebarWidth: 320 } }]);
  });

  it("setSectionHeight rounds and saves the section's height leaf", async () => {
    actions.setSectionHeight("tags", 300.4);
    actions.setSectionHeight("branches", 199.6);
    expect(settings().layout).toMatchObject({ tagsHeight: 300, branchesHeight: 200 });
    expect(await patches()).toEqual([{ layout: { tagsHeight: 300, branchesHeight: 200 } }]);
  });

  it("setSectionHeight with null clears the leaf back to automatic", async () => {
    actions.setSectionHeight("pullRequests", 150);
    actions.setSectionHeight("pullRequests", null);
    expect(settings().layout.pullRequestsHeight).toBeNull();
    expect(await patches()).toEqual([{ layout: { pullRequestsHeight: null } }]);
  });

  it("the defaults carry four null section heights", () => {
    expect(DEFAULT_SETTINGS.layout).toMatchObject({
      branchesHeight: null,
      stashesHeight: null,
      tagsHeight: null,
      pullRequestsHeight: null,
    });
  });

  it("the collapsed-section setters set their flags", async () => {
    actions.setTagsCollapsed(false);
    actions.setPullRequestsCollapsed(true);
    actions.setIssuesCollapsed(false);
    expect(settings().layout).toMatchObject({
      tagsCollapsed: false,
      pullRequestsCollapsed: true,
      issuesCollapsed: false,
    });
    expect(await patches()).toEqual([
      { layout: { tagsCollapsed: false, pullRequestsCollapsed: true, issuesCollapsed: false } },
    ]);
  });

  it("setWorktreesCollapsed sets its flag", async () => {
    actions.setWorktreesCollapsed(true);
    expect(settings().layout.worktreesCollapsed).toBe(true);
    expect(await patches()).toEqual([{ layout: { worktreesCollapsed: true } }]);
  });

  it("the defaults show the worktrees section expanded at automatic height", () => {
    expect(DEFAULT_SETTINGS.layout).toMatchObject({
      worktreesCollapsed: false,
      worktreesHeight: null,
    });
  });
});

describe("clone and updates setters", () => {
  it("setCloneUrlForm and setCheckOnStartup set their sections", async () => {
    actions.setCloneUrlForm("ssh");
    actions.setCheckOnStartup(false);
    expect(settings().clone.urlForm).toBe("ssh");
    expect(settings().updates.checkOnStartup).toBe(false);
    expect(await patches()).toEqual([
      { clone: { urlForm: "ssh" }, updates: { checkOnStartup: false } },
    ]);
  });
});
