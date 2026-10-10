// -*- coding: utf-8 -*-
//! approval.rs
//! Independent local approval surface
//! =====================
//! Collect an explicit user decision outside the browser process and desktop input bindings.
use std::io::{self, Read};

use serde::Deserialize;
use serde_json::json;

/// Review contains identifiers and origin exclusively.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    id: String,
    session_id: String,
    request_id: String,
    action: String,
    origin: String,
    digest: String,
}

/// Display one independent decision and write its inherited-channel response.
///
/// Args:
///     None.
/// Returns:
///     io::Result<()>: Completion of the explicit local decision.
pub fn run() -> io::Result<()> {
    let mut bytes = Vec::new();
    io::stdin().take(4097).read_to_end(&mut bytes)?;
    // Bound the review payload and reject control characters in UI metadata.
    if bytes.len() > 4096 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let review: Review = serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidInput)?;
    for field in [
        &review.id,
        &review.session_id,
        &review.request_id,
        &review.action,
        &review.origin,
        &review.digest,
    ] {
        if field.len() > 256 || field.chars().any(char::is_control) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    let prompt = format!(
        "Approve this exact browser operation?\n\nAction: {}\nOrigin: {}\nSession: {}\nRequest: {}\nPayload SHA-256: {}\n\nOnly choose Yes after reviewing the intended operation in the browser. This decision expires after five minutes.",
        review.action, review.origin, review.session_id, review.request_id, review.digest
    );
    let approved = display(&prompt)?;
    println!("{}", json!({"id":review.id,"approved":approved}));
    Ok(())
}

/// Display an OS-owned approval dialog with a deny default.
///
/// Args:
///     prompt (&str): Bounded review metadata.
/// Returns:
///     io::Result<bool>: Explicit user decision.
#[cfg(windows)]
fn display(prompt: &str) -> io::Result<bool> {
    use windows::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO, MessageBoxW,
    };
    use windows::core::PCWSTR;
    let text: Vec<u16> = prompt.encode_utf16().chain(Some(0)).collect();
    let caption: Vec<u16> = "ABR - Local approval"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // Keep the decision surface in a separate process from every owned browser window.
    let result = unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(caption.as_ptr()),
            MB_YESNO | MB_DEFBUTTON2 | MB_ICONWARNING | MB_SETFOREGROUND,
        )
    };
    Ok(result == IDYES)
}

/// Report an unavailable native approval UI on an unimplemented platform.
///
/// Args:
///     prompt (&str): Bounded review metadata.
/// Returns:
///     io::Result<bool>: Explicit unavailable result.
#[cfg(not(windows))]
fn display(_prompt: &str) -> io::Result<bool> {
    Err(io::ErrorKind::Unsupported.into())
}
