export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
] as const;

type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

const MIME: Record<ImageExtension, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}

function isImageExtension(ext: string): ext is ImageExtension {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Whether the viewer should preview `path` as an image (SVG diffs as text). */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && isImageExtension(ext);
}

export function mimeFor(path: string): string {
  const ext = extensionOf(path);
  return ext !== null && isImageExtension(ext) ? MIME[ext] : "application/octet-stream";
}
