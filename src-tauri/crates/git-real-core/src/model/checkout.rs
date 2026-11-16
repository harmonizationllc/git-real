//! What a checkout reports back: whether it had to stash local changes to
//! switch, and how reapplying them went.

use serde::Serialize;

use super::LocalBranch;

/// How popping the auto-stash on the target ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoStashReapply {
    /// Reapplied and dropped.
    Applied,
    /// Reapplied with conflicts; the stash is kept.
    Conflicts,
    /// Reapplied, but the stash could not be dropped.
    AppliedNotDropped,
    /// Not reapplied; the stash is intact in the stash list.
    Kept,
}

/// Local changes a checkout stashed to get past git's refusal, and how
/// reapplying them went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStash {
    /// Tracked files the stash holds.
    pub files: u32,
    pub reapply: AutoStashReapply,
    /// The failed pop's output, only for `Kept`.
    pub detail: Option<String>,
}

/// The result of a checkout; `auto_stash` is `None` when git switched as-is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOutcome {
    pub auto_stash: Option<AutoStash>,
}

/// A branch created and checked out, with the checkout's auto-stash report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBranch {
    pub branch: LocalBranch,
    pub auto_stash: Option<AutoStash>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reapply_serialises_camel_case() {
        assert_eq!(
            serde_json::to_value(AutoStashReapply::AppliedNotDropped).unwrap(),
            serde_json::json!("appliedNotDropped")
        );
        assert_eq!(
            serde_json::to_value(AutoStashReapply::Kept).unwrap(),
            serde_json::json!("kept")
        );
    }

    #[test]
    fn outcome_without_a_stash_serialises_null() {
        assert_eq!(
            serde_json::to_value(CheckoutOutcome { auto_stash: None }).unwrap(),
            serde_json::json!({ "autoStash": null })
        );
    }

    #[test]
    fn outcome_with_a_stash_serialises_the_report() {
        let o = CheckoutOutcome {
            auto_stash: Some(AutoStash {
                files: 2,
                reapply: AutoStashReapply::Applied,
                detail: None,
            }),
        };
        assert_eq!(
            serde_json::to_value(o).unwrap(),
            serde_json::json!({ "autoStash": { "files": 2, "reapply": "applied", "detail": null } })
        );
    }
}
