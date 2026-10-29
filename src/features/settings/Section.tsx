import { useId } from "react";
import type { SettingsSection } from "../../lib/store/shell";
import styles from "./SettingsDialog.module.css";

/** A titled section tagged with `data-section` so a `section` prop can focus and scroll to it. */
export function Section({
  id,
  name,
  children,
}: {
  id: SettingsSection;
  name: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section data-section={id} aria-labelledby={headingId} className={styles.section}>
      <h3 id={headingId} className={styles.sectionTitle}>
        {name}
      </h3>
      {children}
    </section>
  );
}
