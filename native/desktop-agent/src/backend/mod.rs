// -*- coding: utf-8 -*-
//! mod.rs
//! Platform desktop backend selection
//! =====================
//! Select native desktop implementations and share safe backend failures.

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{DesktopBackend, interrupt};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{DesktopBackend, interrupt};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{DesktopBackend, interrupt};

#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod url_authority;

/// BackendError
/// Represent a stable, diagnostic-safe desktop operation failure.
#[derive(Debug, Clone)]
pub struct BackendError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl BackendError {
    /// Construct an error using fixed messages that exclude application data.
    ///
    /// Args:
    ///     code: Stable browser error code.
    ///     message: Fixed description of the failure.
    ///     retryable: Whether a new observation can permit recovery.
    ///
    /// Returns:
    ///     Self: A serializable backend error.
    pub fn new(code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message,
            retryable,
        }
    }
}
