//! Network operations through the system `git` CLI.
//!
//! Per the hybrid backend rule, anything touching the network, credentials, or
//! signing goes through the CLI rather than `git2`.

pub mod clone;
pub mod progress_parser;
