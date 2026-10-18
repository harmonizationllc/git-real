import type { CommitConfig, SigningFormat } from "../../lib/ipc";
import styles from "./AuthorLine.module.css";

const BADGE: Record<SigningFormat, string> = {
  openPgp: "Signs with GPG",
  ssh: "Signs with SSH",
  x509: "Signs with X.509",
};

export function AuthorLine({ config }: { config: CommitConfig | undefined }): React.JSX.Element {
  if (config === undefined) return <p className={styles.root} aria-busy="true" />;
  const identity =
    config.name !== null && config.email !== null
      ? `${config.name} <${config.email}>`
      : "Author not configured";
  return (
    <p className={styles.root}>
      <span className={styles.identity}>{identity}</span>
      {config.signing !== null && <span className={styles.badge}>{BADGE[config.signing]}</span>}
    </p>
  );
}
