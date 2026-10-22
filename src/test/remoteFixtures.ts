import type {
  AppError,
  BranchList,
  HeadState,
  NetworkErrorInfo,
  NetworkErrorKind,
  RemoteInfo,
  Tracking,
} from "../lib/ipc";
import { oidOf } from "./graphFixtures";

/** A remote whose fetch URL is `/srv/<name>.git` and that has no separate push URL. */
export const remoteInfo = (name: string, over: Partial<RemoteInfo> = {}): RemoteInfo => ({
  name,
  fetchUrl: `/srv/${name}.git`,
  pushUrl: null,
  ...over,
});

/** A networkFailed error: a push over SSH or a local path, with git's output as the message. */
export const networkError = (
  kind: NetworkErrorKind,
  over: Partial<NetworkErrorInfo> = {},
  message = "git output",
): AppError => ({
  kind: "networkFailed",
  message,
  network: { verb: "push", kind, https: false, origin: null, ...over },
});

/** An HTTPS auth failure on https://github.com, which the credential prompt can answer. */
export const authError = (
  kind: "httpsAuthRequired" | "httpsAuthRejected" = "httpsAuthRequired",
): AppError => networkError(kind, { https: true, origin: "https://github.com" });

/** A branch list with one local `main` at HEAD (or `head`) carrying `tracking`, and no remote groups. */
export const trackedList = (
  tracking: Tracking | null,
  head: HeadState = { kind: "branch", name: "main" },
): BranchList => ({
  head,
  local: [{ name: "main", oid: oidOf(1), isHead: true, tracking }],
  remotes: [],
});
