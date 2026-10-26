import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostingListIssues,
  hostingListPullRequests,
  hostingRepoContext,
  listBranches,
  listRemotes,
  listStashes,
  listTags,
  pullDefaultMode,
} from "../lib/ipc";
import type { BranchList } from "../lib/ipc";
import { useSettings } from "../lib/store/settings";
import { useWorkspace } from "../lib/store/workspace";
import { resetSettings, seedSettings } from "../test/settingsStore";
import { remoteInfo } from "../test/remoteFixtures";
import { renderWithProviders } from "../test/renderWithProviders";
import { RefsColumn } from "./RefsColumn";
import { REFS_SECTIONS } from "./refsLayout";

vi.mock("@tanstack/react-virtual", () => import("../test/mockVirtualizer"));

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  hostingListIssues: vi.fn(),
  hostingListPullRequests: vi.fn(),
  hostingRepoContext: vi.fn(),
  listBranches: vi.fn(),
  listRemotes: vi.fn(),
  listStashes: vi.fn(),
  listTags: vi.fn(),
  pullDefaultMode: vi.fn(),
}));

const branchList = (): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [
    {
      name: "main",
      oid: "a".repeat(40),
      isHead: true,
      tracking: { upstream: "origin/main", ahead: 0, behind: 0 },
    },
  ],
  remotes: [],
});

// Records every observer and its targets; fire() delivers one batch shaped like the real API.
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  fire(entries: Array<{ target: Element; height: number }>) {
    this.callback(
      entries.map(
        ({ target, height }) => ({ target, contentRect: { height } }) as ResizeObserverEntry,
      ),
      this as never,
    );
  }
}

const observer = () => StubResizeObserver.instances[0] as StubResizeObserver;
const root = () => screen.getByTestId("refs-column");
const wrapper = (s: string) => root().querySelector(`[data-section="${s}"]`) as HTMLElement;
const content = (s: string) => wrapper(s).firstElementChild as HTMLElement;
const handle = (name: string) => screen.getByRole("separator", { name });

// Root 624 (= 600 + 4 handles of 6); naturals for branches, stashes, tags, pullRequests, issues.
const NATURALS = [200, 60, 150, 36, 36];
const sectionEntries = () =>
  REFS_SECTIONS.map((s, i) => ({ target: content(s), height: NATURALS[i] as number }));

function measure() {
  act(() => observer().fire([{ target: root(), height: 624 }, ...sectionEntries()]));
}

async function renderColumn() {
  const result = renderWithProviders(
    <RefsColumn repoId={1} onOpenRemotes={vi.fn()} onCreatePullRequest={null} />,
  );
  await screen.findByRole("region", { name: "Branches" });
  return result;
}

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  StubResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  useWorkspace.setState({
    selected: {},
    selectedCommit: {},
    selectedStash: {},
    historyPath: {},
    centreView: {},
    refsFilter: {},
  });
  vi.mocked(listBranches).mockResolvedValue(branchList());
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
  vi.mocked(listStashes).mockResolvedValue([]);
  vi.mocked(listTags).mockResolvedValue({ tags: [], remotes: [] });
  vi.mocked(pullDefaultMode).mockResolvedValue("merge");
  vi.mocked(hostingRepoContext).mockResolvedValue(null);
  vi.mocked(hostingListPullRequests).mockResolvedValue([]);
  vi.mocked(hostingListIssues).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Contract: five sections in column order with four labelled horizontal handles between them.
describe("RefsColumn structure", () => {
  it("should render the five sections in order with four horizontal handles between them", async () => {
    await renderColumn();
    const sections = [...root().querySelectorAll("[data-section]")].map((e) =>
      e.getAttribute("data-section"),
    );
    expect(sections).toEqual(["branches", "stashes", "tags", "pullRequests", "issues"]);
    const handles = screen.getAllByRole("separator");
    expect(handles.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Resize Branches section",
      "Resize Stashes section",
      "Resize Tags section",
      "Resize Pull requests section",
    ]);
    for (const h of handles) expect(h).toHaveAttribute("aria-orientation", "horizontal");
  });
});

// Contract: inline heights come from fitSections once the root and every section have reported.
describe("RefsColumn measurement", () => {
  it("should set no inline heights until the root and every section are measured", async () => {
    await renderColumn();
    act(() => observer().fire([{ target: root(), height: 624 }]));
    expect(wrapper("tags").style.height).toBe("");
  });

  it("should apply fitSections heights once measured", async () => {
    await renderColumn();
    measure();
    expect(wrapper("branches").style.height).toBe("318px");
    expect(wrapper("tags").style.height).toBe("150px");
  });

  it("should ignore an entry for an unknown target", async () => {
    await renderColumn();
    act(() => observer().fire([{ target: document.body, height: 624 }, ...sectionEntries()]));
    expect(wrapper("tags").style.height).toBe("");
  });

  it("should ignore an entry without a target", async () => {
    await renderColumn();
    act(() =>
      observer().callback(
        [{ contentRect: { height: 624 } } as ResizeObserverEntry],
        observer() as never,
      ),
    );
    expect(wrapper("tags").style.height).toBe("");
  });

  it("should observe the root and the five content wrappers with one observer and disconnect on unmount", async () => {
    const { unmount } = await renderColumn();
    expect(StubResizeObserver.instances).toHaveLength(1);
    const targets = observer().observe.mock.calls.map(([t]) => t);
    expect(targets).toEqual([root(), ...REFS_SECTIONS.map(content)]);
    unmount();
    expect(observer().disconnect).toHaveBeenCalled();
  });
});

// Contract: a handle shows the rendered height, the floor and the maximum, and edits the stored leaf.
describe("RefsColumn handles", () => {
  it("should give a handle the rendered height, floor and maximum", async () => {
    await renderColumn();
    measure();
    const tags = handle("Resize Tags section");
    expect(tags).toHaveAttribute("aria-valuenow", "150");
    expect(tags).toHaveAttribute("aria-valuemin", "72");
    expect(tags).toHaveAttribute("aria-valuemax", "396");
  });

  it("should persist a keyboard resize to the section's height leaf", async () => {
    await renderColumn();
    measure();
    fireEvent.keyDown(handle("Resize Tags section"), { key: "ArrowDown" });
    expect(useSettings.getState().settings.layout.tagsHeight).toBe(166);
  });

  it("should reset the section to automatic on double-click", async () => {
    await seedSettings({ layout: { tagsHeight: 120 } });
    await renderColumn();
    measure();
    fireEvent.doubleClick(handle("Resize Tags section"));
    expect(useSettings.getState().settings.layout.tagsHeight).toBeNull();
  });

  it("should render a stored height through fitSections", async () => {
    await seedSettings({ layout: { tagsHeight: 120 } });
    await renderColumn();
    measure();
    expect(wrapper("tags").style.height).toBe("120px");
    expect(wrapper("branches").style.height).toBe("348px");
  });
});
