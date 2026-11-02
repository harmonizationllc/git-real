// design-sync barrel: the components synced to the Claude Design project.
// Not used by the app. Add a line here to sync another component.
// Tokens, base styles and syntax colours ship inside the component stylesheet.
import "../src/styles/tokens.css";
import "../src/styles/global.css";
import "../src/styles/syntax.css";
export { ConfirmDialog } from "../src/components/ConfirmDialog";
export type { ConfirmDialogProps } from "../src/components/ConfirmDialog";
export { PromptDialog } from "../src/components/PromptDialog";
export type { PromptDialogProps } from "../src/components/PromptDialog";
export { ContextMenu } from "../src/components/ContextMenu";
export type { ContextMenuProps, MenuItem } from "../src/components/ContextMenu";
export { SplitHandle } from "../src/components/SplitHandle";
export type { SplitHandleProps } from "../src/components/SplitHandle";
export { Toasts } from "../src/components/Toasts";
export { TabBar } from "../src/app/TabBar";
export type { TabBarProps } from "../src/app/TabBar";
export { StatusBadge } from "../src/features/worktree/StatusBadge";
export type { StatusBadgeProps } from "../src/features/worktree/StatusBadge";
export { FileRow } from "../src/features/worktree/FileRow";
export type { FileRowProps } from "../src/features/worktree/FileRow";
export { BranchRow } from "../src/features/branches/BranchRow";
export type { BranchRowProps } from "../src/features/branches/BranchRow";
export { StashRow } from "../src/features/stash/StashRow";
export type { StashRowProps } from "../src/features/stash/StashRow";
export { TagRow } from "../src/features/tags/TagRow";
export type { TagRowProps } from "../src/features/tags/TagRow";
export { HistoryRow } from "../src/features/history/HistoryRow";
export type { HistoryRowProps } from "../src/features/history/HistoryRow";
export { RefLabels } from "../src/features/graph/RefLabels";
export type { RefLabelsProps } from "../src/features/graph/RefLabels";
export { GraphToolbar } from "../src/features/graph/GraphToolbar";
export type { GraphToolbarProps } from "../src/features/graph/GraphToolbar";
export { SyncToolbar } from "../src/features/remotes/SyncToolbar";
export type { SyncToolbarProps } from "../src/features/remotes/SyncToolbar";
export { SyncMessage } from "../src/features/remotes/SyncMessage";
export type { SyncMessageProps } from "../src/features/remotes/SyncMessage";
export { NetworkError } from "../src/features/remotes/NetworkError";
export type { NetworkErrorProps } from "../src/features/remotes/NetworkError";
export { RepoError } from "../src/features/repo/RepoError";
export type { RepoErrorProps } from "../src/features/repo/RepoError";
export { HunkHeader } from "../src/features/diff/HunkHeader";
export { FileHeader } from "../src/features/diff/FileHeader";
export type { FileHeaderProps } from "../src/features/diff/FileHeader";
export { Section } from "../src/features/settings/Section";
export { TextSetting } from "../src/features/settings/TextSetting";
export type { TextSettingProps } from "../src/features/settings/TextSetting";

// Store the Toasts preview pushes into; not a component.
export { useToasts } from "../src/lib/store/toasts";
