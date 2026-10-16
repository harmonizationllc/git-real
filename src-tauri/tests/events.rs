//! Integration tests for the clone-progress event contract.

use git_real_core::{Progress, ProgressPhase};
use git_real_lib::events::{CLONE_PROGRESS, CloneProgressPayload};
use serde_json::json;

// Event name: the front end subscribes to this exact string.
#[test]
fn clone_progress_event_name() {
    assert_eq!(CLONE_PROGRESS, "clone-progress");
}

// Wire format: camelCase keys, nested progress, no extra fields.
#[test]
fn clone_progress_payload_serializes_camel_case() {
    let payload = CloneProgressPayload {
        clone_id: 7,
        progress: Progress {
            phase: ProgressPhase::Receiving,
            percent: Some(42),
            message: "Receiving objects".into(),
        },
    };
    assert_eq!(
        serde_json::to_value(payload).unwrap(),
        json!({
            "cloneId": 7,
            "progress": {"phase": "receiving", "percent": 42, "message": "Receiving objects"}
        })
    );
}

#[test]
fn clone_progress_payload_serializes_missing_percent_as_null() {
    let payload = CloneProgressPayload {
        clone_id: 1,
        progress: Progress {
            phase: ProgressPhase::Other,
            percent: None,
            message: "hello".into(),
        },
    };
    let value = serde_json::to_value(payload).unwrap();
    assert_eq!(value["progress"]["percent"], json!(null));
}
