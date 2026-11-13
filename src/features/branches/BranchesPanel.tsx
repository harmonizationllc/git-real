import { BranchesProvider, type BranchesProviderProps } from "./BranchesProvider";
import { LocalSection } from "./LocalSection";
import { RemoteSection } from "./RemoteSection";

export type BranchesPanelProps = Omit<BranchesProviderProps, "children">;

/**
 * Local and Remote on their shared provider, stacked without the column's sizing: the provider's
 * host block (menus, dialogs) first, then the two sections. The column composes the same
 * three parts into separate section wrappers.
 */
export function BranchesPanel(props: BranchesPanelProps) {
  return (
    <BranchesProvider {...props}>
      <LocalSection />
      <RemoteSection />
    </BranchesProvider>
  );
}
