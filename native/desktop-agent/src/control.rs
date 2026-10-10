// -*- coding: utf-8 -*-
//! control.rs
//! Independent local session handover window
//! =====================
//! Emit bounded session-scoped controls from a separate native user surface.
use std::io::{self, Read};
use std::time::Instant;

use serde::Deserialize;

/// ControlBootstrap binds an inherited UI channel to one owned application session.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlBootstrap {
    schema_version: u32,
    session_id: String,
    parent_pid: u32,
    input_process_id: u32,
}

/// Parse a bounded inherited startup request with a concrete parent identity.
///
/// Args:
///     bytes: Bounded startup bytes received from inherited standard input.
/// Returns:
///     io::Result<ControlBootstrap>: Validated session and parent process metadata.
fn parse_bootstrap(bytes: &[u8]) -> io::Result<ControlBootstrap> {
    // Reject oversized, malformed, and undeclared bootstrap metadata before creating a window.
    if bytes.len() > 512 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let bootstrap: ControlBootstrap =
        serde_json::from_slice(bytes).map_err(|_| io::ErrorKind::InvalidInput)?;
    // Session identifiers contain portable metadata only, and process zero has no live owner.
    if bootstrap.schema_version != 1
        || bootstrap.parent_pid == 0
        || bootstrap.input_process_id == 0
        || bootstrap.input_process_id == bootstrap.parent_pid
        || bootstrap.session_id.is_empty()
        || bootstrap.session_id.len() > 128
        || !bootstrap
            .session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_:.".contains(character))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(bootstrap)
}

/// Start a separate current-user session control surface from inherited startup metadata.
///
/// Args:
///     None.
/// Returns:
///     io::Result<()>: Completion of the local UI lifecycle or an explicit unavailable result.
pub fn run() -> io::Result<()> {
    let started = Instant::now();
    let mut bytes = Vec::new();
    io::stdin().take(513).read_to_end(&mut bytes)?;
    let bootstrap = parse_bootstrap(&bytes)?;
    let result = display(bootstrap);
    // Diagnostics contain lifecycle durations exclusively and stay outside the event channel.
    eprintln!(
        "{}",
        serde_json::json!({"phase":"local-control-total","durationMs":started.elapsed().as_millis()})
    );
    result
}

/// Report an explicit unavailable native control surface on an unimplemented platform.
///
/// Args:
///     bootstrap: Validated owned session identity.
/// Returns:
///     io::Result<()>: Unsupported platform capability result.
#[cfg(not(windows))]
fn display(_bootstrap: ControlBootstrap) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(windows)]
mod windows_control {
    use std::ffi::c_void;
    use std::io::{self, Write};

    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WAIT_OBJECT_0, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{COLOR_WINDOW, GetSysColorBrush};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        EnableWindow, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey,
        VK_PAUSE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, CREATESTRUCTW, CreateWindowExW, DefWindowProcW, DestroyWindow,
        DispatchMessageW, GWLP_USERDATA, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, HMENU,
        HWND_TOPMOST, IDC_ARROW, LoadCursorW, MSG, PostQuitMessage, RegisterClassW, SM_CXSCREEN,
        SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetTimer, SetWindowLongPtrW,
        SetWindowPos, SetWindowTextW, ShowWindow, TranslateMessage, WM_CLOSE, WM_COMMAND,
        WM_DESTROY, WM_HOTKEY, WM_NCCREATE, WM_TIMER, WNDCLASSW, WS_CAPTION, WS_CHILD,
        WS_EX_TOOLWINDOW, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
    };
    use windows::core::{PCWSTR, w};

    use super::ControlBootstrap;

    // Button identifiers are separate from the pause hotkey and parent-liveness timer.
    const PAUSE: usize = 101;
    const RESUME: usize = 102;
    const STOP: usize = 103;
    const PAUSE_HOTKEY: i32 = 201;
    const PARENT_TIMER: usize = 301;

    /// WindowState owns one session channel and the actual native child button handles.
    struct WindowState {
        session_id: String,
        parent: ParentHandle,
        input_process: ParentHandle,
        input_process_id: u32,
        buttons: Vec<HWND>,
        stopped: bool,
        hotkey_pause: bool,
    }

    /// ParentHandle releases the owned parent-liveness query handle.
    struct ParentHandle(HANDLE);

    impl Drop for ParentHandle {
        /// Release only the process handle opened for parent-liveness observation.
        ///
        /// Args:
        ///     self: Owned parent process query handle.
        /// Returns:
        ///     None: Completion of native handle cleanup.
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// WindowHandle destroys the owned HWND before its attached Rust state is released.
    struct WindowHandle(HWND);

    impl Drop for WindowHandle {
        /// Destroy only the independently created native UI window.
        ///
        /// Args:
        ///     self: Owned UI window guard.
        /// Returns:
        ///     None: Completion of native window cleanup.
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    /// Emit one closed local control event through the inherited parent channel.
    ///
    /// Args:
    ///     state: Owned native window session state.
    ///     event: Closed ready/pause/resume/stop event identifier.
    /// Returns:
    ///     bool: Whether the event reached the live parent output channel.
    fn emit(state: &WindowState, event: &str) -> bool {
        let value =
            serde_json::json!({"schemaVersion":1,"sessionId":state.session_id,"event":event});
        let mut stdout = io::stdout().lock();
        // Write and flush bounded JSON without panicking across the native window procedure.
        writeln!(stdout, "{value}")
            .and_then(|()| stdout.flush())
            .is_ok()
    }

    /// Emit startup capabilities without changing the browser's foreground ownership.
    ///
    /// Args:
    ///     state: Owned native control window state.
    /// Returns:
    ///     io::Result<()>: Completion of ready capability delivery.
    fn ready(state: &WindowState) -> io::Result<()> {
        let value = serde_json::json!({"schemaVersion":1,"sessionId":state.session_id,"event":"ready","capabilities":{"buttons":true,"hotkeyPause":state.hotkey_pause,"forcedStop":true,"initialNoActivate":true}});
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{value}")?;
        stdout.flush()
    }

    /// Update requested control state after an explicit local user action.
    ///
    /// Args:
    ///     window: Native independent control window.
    ///     state: Owned session state.
    ///     event: Explicit local pause or resume action.
    /// Returns:
    ///     None: Updated requested-state labels and delivered control event.
    fn request(window: HWND, state: &WindowState, event: &str) {
        // A disconnected parent closes this UI instead of retaining an orphan control surface.
        if !emit(state, event) {
            let _ = unsafe { DestroyWindow(window) };
            return;
        }
        let paused = event == "pause";
        let caption = format!(
            "ABR - {} - {} requested",
            state.session_id,
            if paused { "Pause" } else { "Resume" }
        );
        let caption: Vec<u16> = caption.encode_utf16().chain(Some(0)).collect();
        // Native buttons indicate requested state; the protected parent performs actual lifecycle changes.
        unsafe {
            let _ = EnableWindow(state.buttons[0], !paused);
            let _ = EnableWindow(state.buttons[1], paused);
            let _ = SetWindowTextW(window, PCWSTR(caption.as_ptr()));
        }
    }

    /// Process native button notifications and the explicitly registered local pause hotkey.
    ///
    /// Args:
    ///     window: Independent owned control HWND.
    ///     message: Native message identifier.
    ///     wparam: Native command/hotkey/timer metadata.
    ///     lparam: Native child control handle or creation metadata.
    /// Returns:
    ///     LRESULT: Native window procedure dispatch result.
    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // Bind the heap-owned state during the actual window creation notification.
        if message == WM_NCCREATE {
            let created = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
            unsafe { SetWindowLongPtrW(window, GWLP_USERDATA, created.lpCreateParams as isize) };
        }
        let pointer = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) } as *mut WindowState;
        // Creation and teardown messages can occur before state is attached.
        if pointer.is_null() {
            return unsafe { DefWindowProcW(window, message, wparam, lparam) };
        }
        // Teardown and ordinary repaint messages avoid borrowing attached state during reentrancy.
        if message == WM_DESTROY {
            unsafe { PostQuitMessage(0) };
            return LRESULT(0);
        }
        if !matches!(message, WM_COMMAND | WM_HOTKEY | WM_TIMER | WM_CLOSE) {
            return unsafe { DefWindowProcW(window, message, wparam, lparam) };
        }
        let state = unsafe { &mut *pointer };
        // Validate notification source against the exact native button HWND created by this process.
        if message == WM_COMMAND {
            let identifier = wparam.0 & 0xffff;
            let notification = (wparam.0 >> 16) & 0xffff;
            let index = match identifier {
                PAUSE => 0,
                RESUME => 1,
                STOP => 2,
                _ => return LRESULT(0),
            };
            if notification != 0
                || state
                    .buttons
                    .get(index)
                    .is_none_or(|button| button.0 as isize != lparam.0)
            {
                return LRESULT(0);
            }
            // Stop closes the UI after delivering the session-scoped forced-close request.
            if identifier == STOP {
                state.stopped = true;
                emit(state, "stop");
                let _ = unsafe { DestroyWindow(window) };
            } else {
                // A physical Resume button grants foreground eligibility to this owned input agent only.
                if identifier == RESUME
                    && (unsafe { WaitForSingleObject(state.input_process.0, 0) } == WAIT_OBJECT_0
                        || unsafe { AllowSetForegroundWindow(state.input_process_id) }.is_err())
                {
                    let _ = unsafe {
                        SetWindowTextW(window, w!("ABR - Resume focus permission required"))
                    };
                    return LRESULT(0);
                }
                request(
                    window,
                    state,
                    if identifier == PAUSE {
                        "pause"
                    } else {
                        "resume"
                    },
                );
            }
            return LRESULT(0);
        }
        // The bounded registered hotkey requests pause exclusively.
        if message == WM_HOTKEY && wparam.0 == PAUSE_HOTKEY as usize && state.hotkey_pause {
            request(window, state, "pause");
            return LRESULT(0);
        }
        // Parent exit closes the UI without emitting a request to an unavailable application.
        if message == WM_TIMER
            && wparam.0 == PARENT_TIMER
            && unsafe { WaitForSingleObject(state.parent.0, 0) } == WAIT_OBJECT_0
        {
            state.stopped = true;
            let _ = unsafe { DestroyWindow(window) };
            return LRESULT(0);
        }
        // The native close button represents an explicit local stop request.
        if message == WM_CLOSE {
            if !state.stopped {
                state.stopped = true;
                emit(state, "stop");
            }
            let _ = unsafe { DestroyWindow(window) };
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }

    /// Construct and run the native window while retaining all state for its message lifetime.
    ///
    /// Args:
    ///     bootstrap: Validated inherited session and parent identity.
    /// Returns:
    ///     io::Result<()>: Completion of the independent native UI lifecycle.
    pub(super) fn display(bootstrap: ControlBootstrap) -> io::Result<()> {
        let module = unsafe { GetModuleHandleW(None) }.map_err(|_| io::ErrorKind::Other)?;
        let instance = HINSTANCE(module.0);
        let parent = ParentHandle(
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, bootstrap.parent_pid) }
                .map_err(|_| io::ErrorKind::PermissionDenied)?,
        );
        let input_process = ParentHandle(
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, bootstrap.input_process_id) }
                .map_err(|_| io::ErrorKind::PermissionDenied)?,
        );
        let mut state = Box::new(WindowState {
            session_id: bootstrap.session_id,
            parent,
            input_process,
            input_process_id: bootstrap.input_process_id,
            buttons: Vec::new(),
            stopped: false,
            hotkey_pause: false,
        });
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: unsafe { LoadCursorW(None, IDC_ARROW) }.map_err(|_| io::ErrorKind::Other)?,
            hbrBackground: unsafe { GetSysColorBrush(COLOR_WINDOW) },
            lpszClassName: w!("ABRIndependentSessionControl"),
            ..Default::default()
        };
        // Register an application-owned native window class in this independent process.
        if unsafe { RegisterClassW(&class) } == 0 {
            return Err(io::ErrorKind::Other.into());
        }
        let screen_width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let caption: Vec<u16> = format!("ABR - {}", state.session_id)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let window = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                w!("ABRIndependentSessionControl"),
                PCWSTR(caption.as_ptr()),
                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                (screen_width - 350).max(0),
                40,
                330,
                130,
                None,
                None,
                Some(instance),
                Some((&mut *state as *mut WindowState).cast::<c_void>()),
            )
        }
        .map_err(|_| io::ErrorKind::Other)?;
        let window_guard = WindowHandle(window);
        // Build actual native controls with distinct session-action identifiers.
        for (index, (identifier, title)) in [(PAUSE, "Pause"), (RESUME, "Resume"), (STOP, "Stop")]
            .into_iter()
            .enumerate()
        {
            let text: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
            let button = unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("BUTTON"),
                    PCWSTR(text.as_ptr()),
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                    12 + index as i32 * 100,
                    12,
                    90,
                    32,
                    Some(window),
                    Some(HMENU(identifier as *mut c_void)),
                    Some(instance),
                    None,
                )
            }
            .map_err(|_| io::ErrorKind::Other)?;
            state.buttons.push(button);
        }
        // A pause hotkey is reported supported only when the OS registration actually succeeds.
        state.hotkey_pause = unsafe {
            RegisterHotKey(
                Some(window),
                PAUSE_HOTKEY,
                MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                VK_PAUSE.0 as u32,
            )
        }
        .is_ok();
        // Display the actual shortcut registration result directly on the independent user surface.
        let hint = if state.hotkey_pause {
            "Pause shortcut: Ctrl+Alt+Pause"
        } else {
            "Pause shortcut unavailable; use Pause"
        };
        let hint: Vec<u16> = hint.encode_utf16().chain(Some(0)).collect();
        let _ = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                PCWSTR(hint.as_ptr()),
                WS_CHILD | WS_VISIBLE,
                12,
                54,
                302,
                24,
                Some(window),
                None,
                Some(instance),
                None,
            )
        }
        .map_err(|_| io::ErrorKind::Other)?;
        let parent_timer = unsafe {
            let _ = EnableWindow(state.buttons[1], false);
            SetTimer(Some(window), PARENT_TIMER, 1000, None)
        };
        // Parent-liveness observation is required before announcing an available control surface.
        if parent_timer == 0 {
            return Err(io::ErrorKind::Other.into());
        }
        unsafe {
            let _ = SetWindowPos(
                window,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
        }
        ready(&state)?;
        let mut message = MSG::default();
        // Dispatch only this process's local native UI messages until explicit stop or parent exit.
        loop {
            let status = unsafe { GetMessageW(&mut message, None, 0, 0) }.0;
            if status == -1 {
                let _ = unsafe { DestroyWindow(window) };
                break;
            }
            if status == 0 {
                break;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        // Release only native controls and handles owned by this independent helper.
        if state.hotkey_pause {
            let _ = unsafe { UnregisterHotKey(Some(window), PAUSE_HOTKEY) };
        }
        drop(window_guard);
        Ok(())
    }
}

/// Display the Windows-specific independent handover window.
///
/// Args:
///     bootstrap: Validated owned session and parent identity.
/// Returns:
///     io::Result<()>: Completion of the supported native UI lifecycle.
#[cfg(windows)]
fn display(bootstrap: ControlBootstrap) -> io::Result<()> {
    windows_control::display(bootstrap)
}

#[cfg(test)]
mod tests {
    use super::parse_bootstrap;

    /// Verify closed, bounded, printable inherited bootstrap metadata.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     None: Completion of bootstrap boundary assertions.
    #[test]
    fn bootstrap_is_closed_and_session_scoped() {
        assert!(
            parse_bootstrap(br#"{"schemaVersion":1,"sessionId":"owned-session","parentPid":42,"inputProcessId":43}"#)
                .is_ok()
        );
        assert!(
            parse_bootstrap(
                br#"{"schemaVersion":1,"sessionId":"owned-session","parentPid":42,"inputProcessId":43,"approve":true}"#
            )
            .is_err()
        );
        assert!(
            parse_bootstrap(br#"{"schemaVersion":1,"sessionId":"bad\nvalue","parentPid":42,"inputProcessId":43}"#)
                .is_err()
        );
        assert!(
            parse_bootstrap(br#"{"schemaVersion":1,"sessionId":"owned-session","parentPid":0,"inputProcessId":43}"#)
                .is_err()
        );
        assert!(parse_bootstrap(&[b'x'; 513]).is_err());
        assert!(parse_bootstrap(br#"{"schemaVersion":1,"sessionId":"owned-session","parentPid":42,"inputProcessId":42}"#).is_err());
    }
}
