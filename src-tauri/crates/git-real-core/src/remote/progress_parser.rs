//! Pure parsing of the progress text `git` writes to stderr.

use crate::model::{Progress, ProgressPhase};

const PHASES: [(&str, ProgressPhase); 5] = [
    ("Counting objects", ProgressPhase::Counting),
    ("Compressing objects", ProgressPhase::Compressing),
    ("Receiving objects", ProgressPhase::Receiving),
    ("Resolving deltas", ProgressPhase::Resolving),
    ("Updating files", ProgressPhase::CheckingOut),
];

/// Parses one progress line; blank lines yield `None`.
pub fn parse_line(line: &str) -> Option<Progress> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let body = trimmed.strip_prefix("remote: ").unwrap_or(trimmed);
    let phase = PHASES
        .iter()
        .find(|(prefix, _)| body.starts_with(prefix))
        .map_or(ProgressPhase::Other, |(_, phase)| *phase);
    Some(Progress {
        phase,
        percent: find_percent(trimmed),
        message: trimmed.to_owned(),
    })
}

/// Finds the first `\d{1,3}%` and returns it clamped to 100.
fn find_percent(text: &str) -> Option<u8> {
    let bytes = text.as_bytes();
    bytes
        .iter()
        .enumerate()
        .filter(|(_, b)| **b == b'%')
        .find_map(|(i, _)| {
            let digits = bytes[..i]
                .iter()
                .rev()
                .take(3)
                .take_while(|b| b.is_ascii_digit())
                .count();
            if digits == 0 {
                return None;
            }
            let value = bytes[i - digits..i]
                .iter()
                .fold(0u16, |acc, b| acc * 10 + u16::from(b - b'0'));
            u8::try_from(value.min(100)).ok()
        })
}

fn is_terminator(byte: u8) -> bool {
    byte == b'\r' || byte == b'\n'
}

/// Splits a buffer on `\r` or `\n`, dropping empty pieces.
pub fn split_chunks(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| is_terminator(*b))
        .filter(|piece| !piece.is_empty())
        .map(|piece| String::from_utf8_lossy(piece).into_owned())
        .collect()
}

/// Accumulates stderr bytes across reads so lines split between reads survive.
#[derive(Debug, Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    /// Appends `chunk` and returns the complete lines, keeping the tail.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        match self.pending.iter().rposition(|b| is_terminator(*b)) {
            Some(last) => {
                let complete: Vec<u8> = self.pending.drain(..=last).collect();
                split_chunks(&complete)
            }
            None => Vec::new(),
        }
    }

    /// Returns the remaining unterminated tail.
    pub fn finish(self) -> Vec<String> {
        split_chunks(&self.pending)
    }
}
