import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { appVersion, checkForUpdate, openExternal, toAppError } from "../../lib/ipc";
import type { UpdateInfo } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useSettings } from "../../lib/store/settings";
import { setCheckOnStartup } from "../../lib/store/settingsActions";
import { Section } from "./Section";
import styles from "./SettingsDialog.module.css";

/** The repository's source and issues page. */
const REPO_URL = "https://github.com/harmonizationllc/git-real";

/** Version, the startup-check toggle, a manual check, and the source link. */
export function AboutSettings() {
  const version = useQuery({ queryKey: queryKeys.appVersion, queryFn: () => appVersion() });
  const checkOnStartup = useSettings((s) => s.settings.updates.checkOnStartup);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // A manual check never touches lastCheckedAt; only the startup hook does.
      setResult(await checkForUpdate());
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="about" name="About">
      <p className={styles.value}>Git Real{version.data ? ` ${version.data}` : ""}</p>
      <label className={styles.field}>
        <input
          type="checkbox"
          checked={checkOnStartup}
          onChange={(e) => setCheckOnStartup(e.target.checked)}
        />
        Check for updates on startup
      </label>
      <div className={styles.row}>
        <button type="button" disabled={busy} onClick={() => void check()}>
          {busy ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className={styles.error}>
          Couldn&apos;t check for updates: {error}
        </p>
      ) : (
        result !== null && <CheckResult result={result} />
      )}
      <div className={styles.row}>
        <button type="button" onClick={() => void openExternal(REPO_URL)}>
          Source and issues
        </button>
      </div>
    </Section>
  );
}

/** The outcome of a manual check: available (with release notes), up to date, or no release. */
function CheckResult({ result }: { result: UpdateInfo }) {
  if (result.available) {
    const url = result.url;
    return (
      <p role="status" className={styles.value}>
        Git Real {result.latest} is available
        {url !== null && (
          <button type="button" onClick={() => void openExternal(url)}>
            Release notes
          </button>
        )}
      </p>
    );
  }
  return (
    <p role="status" className={styles.value}>
      {result.latest !== null ? "You're up to date" : "No releases published yet"}
    </p>
  );
}
