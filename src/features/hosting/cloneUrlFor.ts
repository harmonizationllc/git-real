import type { HostedRepo } from "../../lib/ipc";
import type { CloneUrlForm } from "../../lib/ipc";

/** The URL in the preferred form, and whether it fell back to HTTPS because the repo has no SSH URL. */
export function cloneUrlFor(
  repo: HostedRepo,
  form: CloneUrlForm,
): { url: string; fellBack: boolean } {
  // An empty SSH URL counts as none.
  if (form === "ssh" && repo.sshUrl) return { url: repo.sshUrl, fellBack: false };
  return { url: repo.httpsUrl, fellBack: form === "ssh" };
}
