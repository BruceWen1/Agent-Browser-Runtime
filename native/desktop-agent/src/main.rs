// -*- coding: utf-8 -*-
/*
main.rs
Desktop agent entry point
=====================

Report the native agent version during initial toolchain verification.
*/
use std::time::Instant;

/// Dispatch the native agent entry point.
///
/// Args:
///     None.
/// Returns:
///     (): Completion of the diagnostic process.
fn main() {
    let started = Instant::now();
    // Keep standard output reserved for explicit machine-readable diagnostics.
    println!("abr-desktop-agent {}", env!("CARGO_PKG_VERSION"));
    eprintln!("agent startup completed in {:?}", started.elapsed());
}
