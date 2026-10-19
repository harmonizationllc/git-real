import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText, getCommit, getCommitFiles } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { commitDetail, oidOf, shortOf } from "../../test/graphFixtures";
import { commitFile } from "../../test/historyFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { fullDate } from "../graph/model/relativeTime";
import { CommitSummary } from "./CommitSummary";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommit: vi.fn(),
  getCommitFiles: vi.fn(),
  copyText: vi.fn(),
}));

const OID = oidOf(0);
const P1 = oidOf(1);
const P2 = oidOf(2);
const T = 1_700_000_000;

const detail = (over = {}) => commitDetail({ oid: OID, parents: [P1, P2], ...over });

async function renderSummary(over = {}, repoId = 1) {
  vi.mocked(getCommit).mockResolvedValue(detail(over));
  const view = renderWithProviders(<CommitSummary repoId={repoId} oid={OID} />);
  await screen.findByRole("region", { name: "Commit details" });
  return view;
}

// A line "Name <email> · date" wherever it sits, tolerant of a label before it.
const personLine = (name: string, email: string, time: number) =>
  screen.getByText(
    new RegExp(`${name} <${email}> · ${fullDate(time).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
const personLines = () => screen.queryAllByText(/<[^>]+@[^>]+> · /);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(copyText).mockResolvedValue(undefined);
  vi.mocked(getCommitFiles).mockResolvedValue([commitFile("src/a.ts")]);
  useWorkspace.setState({ selected: {}, selectedCommit: { 1: OID } });
});

// Contract: a region with the short-hash heading and the full hash in <code>.
describe("CommitSummary header", () => {
  it("should render a Commit details region", async () => {
    await renderSummary();
    expect(screen.getByRole("region", { name: "Commit details" })).toBeInTheDocument();
  });

  it("should head the panel with Commit and the seven-character hash", async () => {
    await renderSummary();
    expect(screen.getByRole("heading", { name: `Commit ${shortOf(OID)}` })).toBeInTheDocument();
  });

  it("should show the full hash in a code element", async () => {
    await renderSummary();
    expect(screen.getByText(OID).tagName).toBe("CODE");
  });

  it("should request the commit for the repo id and oid", async () => {
    await renderSummary({}, 7);
    expect(getCommit).toHaveBeenCalledExactlyOnceWith(7, OID);
  });
});

// Contract: Copy copies the full hash, Close deselects the commit.
describe("CommitSummary buttons", () => {
  it("should copy the full hash when Copy is clicked", async () => {
    await renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(OID);
  });

  it("should show a failed copy as a dismissable alert and keep the panel open", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    await renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("clipboard denied");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Commit details" })).toBeInTheDocument();
    expect(useWorkspace.getState().selectedCommit[1]).toBe(OID);
  });

  it("should not copy anything before Copy is clicked", async () => {
    await renderSummary();
    expect(copyText).not.toHaveBeenCalled();
  });

  it("should clear the commit selection when Close commit details is clicked", async () => {
    await renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "Close commit details" }));
    expect(useWorkspace.getState().selectedCommit[1]).toBeNull();
  });

  it("should keep the selection until Close is clicked", async () => {
    await renderSummary();
    expect(useWorkspace.getState().selectedCommit[1]).toBe(OID);
  });
});

// Contract: author line "Name <email> · date"; committer line only when it differs.
describe("CommitSummary people", () => {
  it("should show the author line with the full date", async () => {
    await renderSummary();
    expect(personLine("Alice", "alice@x.io", T)).toBeInTheDocument();
  });

  it("should show a single person line when the committer equals the author", async () => {
    await renderSummary();
    expect(personLines()).toHaveLength(1);
  });

  it("should show a committer line when the committer name differs", async () => {
    await renderSummary({ committer: { name: "Bob", email: "alice@x.io", time: T } });
    expect(personLine("Bob", "alice@x.io", T)).toBeInTheDocument();
    expect(personLines()).toHaveLength(2);
  });

  it("should show a committer line when the committer email differs", async () => {
    await renderSummary({ committer: { name: "Alice", email: "other@x.io", time: T } });
    expect(personLine("Alice", "other@x.io", T)).toBeInTheDocument();
    expect(personLines()).toHaveLength(2);
  });

  it("should show a committer line when the committer time differs", async () => {
    await renderSummary({ committer: { name: "Alice", email: "alice@x.io", time: T + 86400 } });
    expect(personLine("Alice", "alice@x.io", T + 86400)).toBeInTheDocument();
    expect(personLines()).toHaveLength(2);
  });
});

// Contract: each parent is a button labelled by its seven-character hash that selects it.
describe("CommitSummary parents", () => {
  it("should render a button per parent labelled by its short hash", async () => {
    await renderSummary();
    expect(screen.getByRole("button", { name: shortOf(P1) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: shortOf(P2) })).toBeInTheDocument();
  });

  it("should select the parent commit when its button is clicked", async () => {
    await renderSummary();
    fireEvent.click(screen.getByRole("button", { name: shortOf(P2) }));
    expect(useWorkspace.getState().selectedCommit[1]).toBe(P2);
  });

  it("should select the first parent when its button is clicked", async () => {
    await renderSummary();
    fireEvent.click(screen.getByRole("button", { name: shortOf(P1) }));
    expect(useWorkspace.getState().selectedCommit[1]).toBe(P1);
  });

  it("should render no parent heading or buttons for a root commit", async () => {
    await renderSummary({ parents: [] });
    expect(screen.queryByText(/^Parents/)).toBeNull();
    expect(screen.queryByRole("button", { name: shortOf(P1) })).toBeNull();
  });
});

// Contract: subject in bold, body keeping its line breaks.
describe("CommitSummary message", () => {
  it("should show the subject in strong text or a heading", async () => {
    await renderSummary();
    expect(screen.getByText("Fix the thing").tagName).toMatch(/^(STRONG|H[1-6])$/);
  });

  it("should show the body in an element with the body class that preserves line breaks", async () => {
    await renderSummary();
    expect(screen.getByText("Line one Line two").className).toMatch(/body/);
  });

  it("should render no body element for an empty body", async () => {
    await renderSummary({ message: { subject: "Only subject", body: "" } });
    expect(screen.getByText("Only subject")).toBeInTheDocument();
    expect(document.querySelector('[class*="body"]')).toBeNull();
  });
});

// Contract: loading status, and an error with Retry and Dismiss.
describe("CommitSummary loading and error", () => {
  it("should show Loading commit… with role status while loading", () => {
    vi.mocked(getCommit).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CommitSummary repoId={1} oid={OID} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading commit…");
  });

  it("should not show the loading status once loaded", async () => {
    await renderSummary();
    expect(screen.queryByText("Loading commit…")).toBeNull();
  });

  it("should show the error message in an alert on failure", async () => {
    vi.mocked(getCommit).mockRejectedValue({ kind: "commitNotFound", message: "No such commit" });
    renderWithProviders(<CommitSummary repoId={1} oid={OID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No such commit");
  });

  it("should not show the details region on failure", async () => {
    vi.mocked(getCommit).mockRejectedValue({ kind: "commitNotFound", message: "No such commit" });
    renderWithProviders(<CommitSummary repoId={1} oid={OID} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: `Commit ${shortOf(OID)}` })).toBeNull();
  });

  it("should fetch the commit again when Retry is clicked", async () => {
    vi.mocked(getCommit).mockRejectedValue({ kind: "commitNotFound", message: "No such commit" });
    renderWithProviders(<CommitSummary repoId={1} oid={OID} />);
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Retry" }),
    );
    await waitFor(() => expect(getCommit).toHaveBeenCalledTimes(2));
  });

  it("should close the panel when Dismiss is clicked", async () => {
    vi.mocked(getCommit).mockRejectedValue({ kind: "commitNotFound", message: "No such commit" });
    renderWithProviders(<CommitSummary repoId={1} oid={OID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(useWorkspace.getState().selectedCommit[1]).toBeNull();
  });
});

// Contract: the changed files of the commit are listed after the message.
describe("CommitSummary files", () => {
  it("should render the Changed files section inside the details region", async () => {
    await renderSummary();
    const details = screen.getByRole("region", { name: "Commit details" });
    expect(
      await within(details).findByRole("region", { name: "Changed files" }),
    ).toBeInTheDocument();
  });

  it("should request the files for the commit's repo id and oid", async () => {
    await renderSummary({}, 7);
    await waitFor(() => expect(getCommitFiles).toHaveBeenCalledExactlyOnceWith(7, OID));
  });

  it("should list the commit's files", async () => {
    await renderSummary();
    expect(await screen.findByRole("heading", { name: "Files (1)" })).toBeInTheDocument();
  });

  it("should place the files after the message", async () => {
    await renderSummary();
    const files = await screen.findByRole("region", { name: "Changed files" });
    const subject = screen.getByText("Fix the thing");
    const body = screen.getByText("Line one Line two");
    expect(subject.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should place the files after the message when the body is empty", async () => {
    await renderSummary({ message: { subject: "Only subject", body: "" } });
    const files = await screen.findByRole("region", { name: "Changed files" });
    expect(
      screen.getByText("Only subject").compareDocumentPosition(files) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("should not request the files when the commit failed to load", async () => {
    vi.mocked(getCommit).mockRejectedValue({ kind: "commitNotFound", message: "No such commit" });
    renderWithProviders(<CommitSummary repoId={1} oid={OID} />);
    await screen.findByRole("alert");
    expect(getCommitFiles).not.toHaveBeenCalled();
  });
});
