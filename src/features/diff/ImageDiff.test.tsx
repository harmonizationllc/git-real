import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFileContent } from "../../lib/ipc";
import type { AppError, ChangeKind, DiffSide, FileDiff } from "../../lib/ipc";
import { fileDiff } from "../../test/diffFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ImageDiff } from "./ImageDiff";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileContent: vi.fn(),
}));

const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

// Old bytes are 1 byte and new bytes are 2 bytes, so each blob URL names its side.
const BYTES: Record<DiffSide, number> = { old: 1, new: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  createObjectURL.mockImplementation((blob) => `blob:${blob.size}`);
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: revokeObjectURL,
    configurable: true,
    writable: true,
  });
  vi.mocked(getFileContent).mockImplementation((_id, _path, _scope, side) =>
    Promise.resolve(new ArrayBuffer(BYTES[side])),
  );
});

afterEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: originalCreate,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: originalRevoke,
    configurable: true,
    writable: true,
  });
});

const imageDiff = (over: Partial<FileDiff> = {}): FileDiff =>
  fileDiff([], { path: "pic.png", isBinary: true, change: "modified", ...over });

const setup = (diff: FileDiff = imageDiff()) =>
  renderWithProviders(<ImageDiff repoId={1} diff={diff} />);

// Contract: a modified image loads and shows both sides.
describe("ImageDiff modified", () => {
  it("should request the old and the new side of the file", async () => {
    setup();
    await screen.findByAltText("New image");
    expect(getFileContent).toHaveBeenCalledWith(1, "pic.png", "unstaged", "old");
    expect(getFileContent).toHaveBeenCalledWith(1, "pic.png", "unstaged", "new");
  });

  it("should use the diff's scope for the requests", async () => {
    setup(imageDiff({ scope: "staged" }));
    await screen.findByAltText("New image");
    expect(getFileContent).toHaveBeenCalledWith(1, "pic.png", "staged", "new");
  });

  it("should render the old image from its blob URL", async () => {
    setup();
    expect(await screen.findByAltText("Old image")).toHaveAttribute("src", "blob:1");
  });

  it("should render the new image from its blob URL", async () => {
    setup();
    expect(await screen.findByAltText("New image")).toHaveAttribute("src", "blob:2");
  });

  it("should caption the sides Old and New before dimensions are known", async () => {
    setup();
    await screen.findByAltText("New image");
    expect(screen.getByText("Old")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("should create each blob with the MIME type of the path", async () => {
    setup(imageDiff({ path: "photo.jpg" }));
    await screen.findByAltText("New image");
    expect(createObjectURL.mock.calls.every(([blob]) => blob.type === "image/jpeg")).toBe(true);
  });

  it("should show a loading status until the content arrives", async () => {
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    setup();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });
});

// Contract: a rename previews the old side from the old path.
describe("ImageDiff rename", () => {
  it("should request the old side with the old path", async () => {
    setup(imageDiff({ path: "renamed.png", oldPath: "README.png", change: "renamed" }));
    await screen.findByAltText("New image");
    expect(getFileContent).toHaveBeenCalledWith(1, "README.png", "unstaged", "old");
  });

  it("should request the new side with the new path", async () => {
    setup(imageDiff({ path: "renamed.png", oldPath: "README.png", change: "renamed" }));
    await screen.findByAltText("New image");
    expect(getFileContent).toHaveBeenCalledWith(1, "renamed.png", "unstaged", "new");
  });

  it("should not request the old side with the new path", async () => {
    setup(imageDiff({ path: "renamed.png", oldPath: "README.png", change: "renamed" }));
    await screen.findByAltText("New image");
    expect(getFileContent).not.toHaveBeenCalledWith(1, "renamed.png", "unstaged", "old");
  });
});

// Contract: added images have only a new side, deleted ones only an old side.
describe("ImageDiff one-sided changes", () => {
  it.each<ChangeKind>(["added", "untracked"])(
    "should request only the new side for %s",
    async (change) => {
      setup(imageDiff({ change }));
      await screen.findByAltText("New image");
      expect(getFileContent).toHaveBeenCalledTimes(1);
      expect(getFileContent).toHaveBeenCalledWith(1, "pic.png", "unstaged", "new");
    },
  );

  it.each<ChangeKind>(["added", "untracked"])(
    "should render no old image for %s",
    async (change) => {
      setup(imageDiff({ change }));
      await screen.findByAltText("New image");
      expect(screen.queryByAltText("Old image")).toBeNull();
    },
  );

  it("should request only the old side for a deleted image", async () => {
    setup(imageDiff({ change: "deleted" }));
    await screen.findByAltText("Old image");
    expect(getFileContent).toHaveBeenCalledTimes(1);
    expect(getFileContent).toHaveBeenCalledWith(1, "pic.png", "unstaged", "old");
  });

  it("should render no new image for a deleted image", async () => {
    setup(imageDiff({ change: "deleted" }));
    await screen.findByAltText("Old image");
    expect(screen.queryByAltText("New image")).toBeNull();
  });
});

// Contract: a failing side shows its error in its own figure and the other side still renders.
describe("ImageDiff errors", () => {
  const failNew = (error: AppError) =>
    vi
      .mocked(getFileContent)
      .mockImplementation((_id, _path, _scope, side) =>
        side === "new" ? Promise.reject(error) : Promise.resolve(new ArrayBuffer(1)),
      );

  it("should explain that the image is too large when the error is tooLarge", async () => {
    failNew({ kind: "tooLarge", message: "File is 30 MB" });
    setup();
    expect(await screen.findByText(/Image too large to preview/)).toBeInTheDocument();
  });

  it("should show the message of a tooLarge error", async () => {
    failNew({ kind: "tooLarge", message: "File is 30 MB" });
    setup();
    expect(await screen.findByText(/File is 30 MB/)).toBeInTheDocument();
  });

  it("should show the error inside the figure of the failing side", async () => {
    failNew({ kind: "tooLarge", message: "File is 30 MB" });
    setup();
    const text = await screen.findByText(/File is 30 MB/);
    expect(text.closest("figure")).toHaveTextContent("New");
  });

  it("should still render the other side", async () => {
    failNew({ kind: "tooLarge", message: "File is 30 MB" });
    setup();
    await screen.findByText(/File is 30 MB/);
    expect(screen.getByAltText("Old image")).toBeInTheDocument();
  });

  it("should show the message of any other error", async () => {
    failNew({ kind: "io", message: "disk gone" });
    setup();
    expect(await screen.findByText(/disk gone/)).toBeInTheDocument();
  });

  it("should not call another error too large", async () => {
    failNew({ kind: "io", message: "disk gone" });
    setup();
    await screen.findByText(/disk gone/);
    expect(screen.queryByText(/Image too large to preview/)).toBeNull();
  });
});

// Contract: once an image has loaded, its natural size is added to the caption.
describe("ImageDiff dimensions", () => {
  it("should add the natural size to the caption after the image loads", async () => {
    setup();
    const img = await screen.findByAltText("New image");
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    fireEvent.load(img);
    expect(screen.getByText("New 640×480")).toBeInTheDocument();
  });

  it("should leave the other caption alone", async () => {
    setup();
    const img = await screen.findByAltText("New image");
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    fireEvent.load(img);
    expect(screen.getByText("Old")).toBeInTheDocument();
  });
});

// Contract: every blob URL is revoked when the preview goes away.
describe("ImageDiff cleanup", () => {
  it("should revoke every created URL on unmount", async () => {
    const { unmount } = setup();
    await screen.findByAltText("New image");
    await screen.findByAltText("Old image");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:2");
  });

  it("should not revoke a URL while its image is shown", async () => {
    setup();
    await screen.findByAltText("New image");
    await screen.findByAltText("Old image");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
