import { useCallback, useMemo, useState, type SyntheticEvent } from "react";
import type { AppError, DiffScope, DiffSide, FileDiff, RepoId } from "../../lib/ipc";
import { mimeFor } from "./model/images";
import { useFileContent } from "./useFileContent";
import styles from "./ImageDiff.module.css";

/** Old and new side of a binary image, side by side. */
export function ImageDiff({ repoId, diff }: { repoId: RepoId; diff: FileDiff }) {
  const hasOld = diff.change !== "added" && diff.change !== "untracked";
  const hasNew = diff.change !== "deleted";
  return (
    <div className={styles.root}>
      {hasOld && (
        <Side
          repoId={repoId}
          path={diff.oldPath ?? diff.path}
          scope={diff.scope}
          side="old"
          label="Old"
        />
      )}
      {hasNew && (
        <Side repoId={repoId} path={diff.path} scope={diff.scope} side="new" label="New" />
      )}
    </div>
  );
}

function Side({
  repoId,
  path,
  scope,
  side,
  label,
}: {
  repoId: RepoId;
  path: string;
  scope: DiffScope;
  side: DiffSide;
  label: string;
}) {
  const { bytes, error, loading } = useFileContent(repoId, path, scope, side, true);
  const blob = useMemo(
    () => (bytes ? new Blob([bytes], { type: mimeFor(path) }) : null),
    [bytes, path],
  );
  const [dims, setDims] = useState<string | null>(null);
  return (
    <figure className={styles.figure}>
      {blob && (
        <BlobImage
          blob={blob}
          alt={`${label} image`}
          onLoad={(e) =>
            setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)
          }
        />
      )}
      {loading && <span role="status">Loading…</span>}
      {error && <ErrorText error={error} />}
      <figcaption>{dims ? `${label} ${dims}` : label}</figcaption>
    </figure>
  );
}

/**
 * Ties the object URL to the element's lifetime: each attach creates its own URL and its
 * cleanup revokes only that one, which stays correct under StrictMode's double mount.
 */
function BlobImage({
  blob,
  alt,
  onLoad,
}: {
  blob: Blob;
  alt: string;
  onLoad(e: SyntheticEvent<HTMLImageElement>): void;
}) {
  const attach = useCallback(
    (img: HTMLImageElement | null) => {
      const url = URL.createObjectURL(blob);
      // A ref callback that returns a cleanup is never called with null.
      (img as HTMLImageElement).src = url;
      return () => URL.revokeObjectURL(url);
    },
    [blob],
  );
  return <img ref={attach} alt={alt} className={styles.img} onLoad={onLoad} />;
}

function ErrorText({ error }: { error: AppError }) {
  return (
    <p className={styles.error}>
      {error.kind === "tooLarge" ? "Image too large to preview. " : ""}
      {error.message}
    </p>
  );
}
