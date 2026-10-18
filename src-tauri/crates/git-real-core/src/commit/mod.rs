//! Composing and recording commits.
//!
//! Message rules live in [`message`]; the commit itself goes through the
//! system `git` CLI so hooks and signing behave exactly as on the command
//! line (ADR 0001).

pub mod message;
