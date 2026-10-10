// -*- coding: utf-8 -*-
/*
macos.rs
macOS desktop backend
=====================

Read bounded Accessibility trees, capture owned windows with ScreenCaptureKit,
and dispatch foreground-validated Quartz input with explicit TCC permissions.
*/
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::{CString, c_char, c_void};
use std::fs::{DirBuilder, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use screencapturekit::prelude::*;
use screencapturekit::screenshot_manager::{CGImageExt, SCScreenshotManager};
use serde_json::{Value, json};

use super::BackendError;
use super::url_authority::{
    UrlPlatform, address_role, chrome_toolbar, consistent_browser_url, document_boundary,
    document_geometry, mac_optional_attribute_status, root_document, trusted_browser_url,
    unique_bound_window_index, unique_window_index,
};

#[link(name = "System")]
unsafe extern "C" {
    /// Read the current effective Unix user identity.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     u32: Current effective user identifier.
    fn geteuid() -> u32;
    /// Transition the native advisory desktop-seat lock.
    ///
    /// Args:
    ///     descriptor (i32): Owned seat-lock file descriptor.
    ///     operation (i32): Native exclusive or unlock flags.
    /// Returns:
    ///     i32: Zero on a successful transition.
    fn flock(descriptor: i32, operation: i32) -> i32;
}

/// Hold an exclusive same-user desktop-seat lease until paired input cleanup.
struct DesktopLease(File);

impl DesktopLease {
    /// Acquire the protected cross-agent input seat without waiting.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Result<Self, BackendError>: Exclusive lease or a classified access failure.
    fn acquire() -> Result<Self, BackendError> {
        let uid = unsafe { geteuid() };
        let root = env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(env::temp_dir);
        let directory = root.join(format!("abr-desktop-seat-{uid}"));
        // Apply private directory permissions atomically at creation.
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => {
                return Err(BackendError::new(
                    "PERMISSION_REQUIRED",
                    "Desktop seat directory is unavailable",
                    true,
                ));
            }
        }
        let metadata = std::fs::symlink_metadata(&directory).map_err(|_| {
            BackendError::new(
                "PERMISSION_REQUIRED",
                "Desktop seat metadata is unavailable",
                true,
            )
        })?;
        // Reject redirected or shared directories before opening a seat file.
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != uid
            || metadata.mode() & 0o077 != 0
        {
            return Err(BackendError::new(
                "POLICY_DENIED",
                "Desktop seat directory ownership is invalid",
                false,
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(0x100)
            .open(directory.join("input-seat.lock"))
            .map_err(|_| {
                BackendError::new(
                    "PERMISSION_REQUIRED",
                    "Desktop seat lease cannot be opened",
                    true,
                )
            })?;
        let metadata = file.metadata().map_err(|_| {
            BackendError::new(
                "PERMISSION_REQUIRED",
                "Desktop seat lease metadata is unavailable",
                true,
            )
        })?;
        // Native O_NOFOLLOW and owner checks reject precreated or hard-linked redirects.
        if !metadata.is_file()
            || metadata.uid() != uid
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(BackendError::new(
                "POLICY_DENIED",
                "Desktop seat lease ownership is invalid",
                false,
            ));
        }
        // Keep cross-agent contention explicit without queueing unbounded native input.
        if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
            return Err(BackendError::new(
                "DESKTOP_BUSY",
                "Another desktop Agent owns the input seat",
                true,
            ));
        }
        Ok(Self(file))
    }
}

impl Drop for DesktopLease {
    /// Release the desktop seat after every accepted input has a paired release.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Completion of native lease release.
    fn drop(&mut self) {
        unsafe { flock(self.0.as_raw_fd(), 8) };
    }
}

type CFRef = *const c_void;
type AXRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    origin: Point,
    size: Size,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    /// Call the native AXIs Process Trusted platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     bool: Native API result or status value.
    fn AXIsProcessTrusted() -> bool;
    /// Call the native AXUIElement Create Application platform API.
    ///
    /// Args:
    ///     pid (i32): Native application process identifier.
    /// Returns:
    ///     AXRef: Native API result or status value.
    fn AXUIElementCreateApplication(pid: i32) -> AXRef;
    /// Call the native AXUIElement Create System Wide platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     AXRef: Native API result or status value.
    fn AXUIElementCreateSystemWide() -> AXRef;
    /// Call the native AXUIElement Copy Attribute Value platform API.
    ///
    /// Args:
    ///     element (AXRef): Borrowed Accessibility element.
    ///     attribute (CFRef): Native attribute name.
    ///     value (*mut CFRef): Native object or output value.
    /// Returns:
    ///     i32: Native API result or status value.
    fn AXUIElementCopyAttributeValue(element: AXRef, attribute: CFRef, value: *mut CFRef) -> i32;
    /// Call the native AXUIElement Set Attribute Value platform API.
    ///
    /// Args:
    ///     element (AXRef): Borrowed Accessibility element.
    ///     attribute (CFRef): Native attribute name.
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     i32: Native API result or status value.
    fn AXUIElementSetAttributeValue(element: AXRef, attribute: CFRef, value: CFRef) -> i32;
    /// Call the native AXUIElement Perform Action platform API.
    ///
    /// Args:
    ///     element (AXRef): Borrowed Accessibility element.
    ///     action (CFRef): Native action identifier.
    /// Returns:
    ///     i32: Native API result or status value.
    fn AXUIElementPerformAction(element: AXRef, action: CFRef) -> i32;
    /// Call the native AXUIElement Set Messaging Timeout platform API.
    ///
    /// Args:
    ///     element (AXRef): Borrowed Accessibility element.
    ///     seconds (f32): Maximum native messaging duration in seconds.
    /// Returns:
    ///     i32: Native API result or status value.
    fn AXUIElementSetMessagingTimeout(element: AXRef, seconds: f32) -> i32;
    /// Call the native AXUIElement Get Pid platform API.
    ///
    /// Args:
    ///     element (AXRef): Borrowed Accessibility element.
    ///     pid (*mut i32): Native application process identifier.
    /// Returns:
    ///     i32: Native API result or status value.
    fn AXUIElementGetPid(element: AXRef, pid: *mut i32) -> i32;
    /// Call the native AXValue Get Value platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    ///     kind (u32): Native object or event category.
    ///     result (*mut c_void): Output native attribute storage.
    /// Returns:
    ///     bool: Native API result or status value.
    fn AXValueGetValue(value: CFRef, kind: u32, result: *mut c_void) -> bool;
}

#[link(name = "System")]
unsafe extern "C" {
    /// Call the native sysctlbyname platform API.
    ///
    /// Args:
    ///     name (*const c_char): Native property lookup name.
    ///     old (*mut c_void): Output native metadata storage.
    ///     old_length (*mut usize): Capacity and result length of output storage.
    ///     new (*mut c_void): Optional replacement storage.
    ///     new_length (usize): Replacement storage length.
    /// Returns:
    ///     i32: Native API result or status value.
    fn sysctlbyname(
        name: *const c_char,
        old: *mut c_void,
        old_length: *mut usize,
        new: *mut c_void,
        new_length: usize,
    ) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    /// Call the native CFRelease platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CFRelease(value: CFRef);
    /// Retain a borrowed native object across the before and after identity reads.
    ///
    /// Args:
    ///     value (CFRef): Live borrowed Core Foundation object.
    /// Returns:
    ///     CFRef: Retained object reference released through the owned wrapper.
    fn CFRetain(value: CFRef) -> CFRef;
    /// Compare native Accessibility object identity through Core Foundation equality.
    ///
    /// Args:
    ///     first (CFRef): Retained object from the initial private read.
    ///     second (CFRef): Retained object from the final private read.
    /// Returns:
    ///     bool: Whether the native objects have equal identity.
    fn CFEqual(first: CFRef, second: CFRef) -> bool;
    /// Call the native CFGet Type ID platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CFGetTypeID(value: CFRef) -> usize;
    /// Call the native CFString Get Type ID platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CFStringGetTypeID() -> usize;
    /// Call the native CFBoolean Get Type ID platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CFBooleanGetTypeID() -> usize;
    /// Call the native CFArray Get Type ID platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CFArrayGetTypeID() -> usize;
    /// Call the native CFHash platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CFHash(value: CFRef) -> usize;
    /// Call the native CFURLGet Type ID platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CFURLGetTypeID() -> usize;
    /// Call the native CFString Create With CString platform API.
    ///
    /// Args:
    ///     allocator (CFRef): Native allocator or the default allocator.
    ///     text (*const c_char): Native string or text storage.
    ///     encoding (u32): Native text encoding identifier.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFStringCreateWithCString(allocator: CFRef, text: *const c_char, encoding: u32) -> CFRef;
    /// Call the native CFString Get CString platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    ///     output (*mut c_char): Caller-owned output storage.
    ///     size (isize): Caller-owned output storage capacity.
    ///     encoding (u32): Native text encoding identifier.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CFStringGetCString(value: CFRef, output: *mut c_char, size: isize, encoding: u32) -> bool;
    /// Call the native CFArray Get Count platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     isize: Native API result or status value.
    fn CFArrayGetCount(value: CFRef) -> isize;
    /// Call the native CFArray Get Value At Index platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    ///     index (isize): Native array index.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFArrayGetValueAtIndex(value: CFRef, index: isize) -> CFRef;
    /// Call the native CFDictionary Get Value platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    ///     key (CFRef): Native property or keyboard key identifier.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFDictionaryGetValue(value: CFRef, key: CFRef) -> CFRef;
    /// Call the native CFNumber Get Value platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    ///     kind (i32): Native object or event category.
    ///     output (*mut c_void): Caller-owned output storage.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CFNumberGetValue(value: CFRef, kind: i32, output: *mut c_void) -> bool;
    /// Call the native CFURLGet String platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFURLGetString(value: CFRef) -> CFRef;
    /// Call the native CFBoolean Get Value platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CFBooleanGetValue(value: CFRef) -> bool;
    /// Call the native CFURLCreate From File System Representation platform API.
    ///
    /// Args:
    ///     allocator (CFRef): Native allocator or the default allocator.
    ///     bytes (*const u8): Native filesystem path bytes.
    ///     length (isize): Native text length or output length.
    ///     directory (bool): Whether the native URL identifies a directory.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CFRef,
        bytes: *const u8,
        length: isize,
        directory: bool,
    ) -> CFRef;
    /// Call the native CFBundle Create platform API.
    ///
    /// Args:
    ///     allocator (CFRef): Native allocator or the default allocator.
    ///     url (CFRef): Native application bundle URL.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFBundleCreate(allocator: CFRef, url: CFRef) -> CFRef;
    /// Call the native CFBundle Get Value For Info Dictionary Key platform API.
    ///
    /// Args:
    ///     bundle (CFRef): Borrowed application bundle.
    ///     key (CFRef): Native property or keyboard key identifier.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFBundleGetValueForInfoDictionaryKey(bundle: CFRef, key: CFRef) -> CFRef;
    /// Call the native CFData Get Byte Ptr platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    /// Returns:
    ///     *const u8: Native API result or status value.
    fn CFDataGetBytePtr(value: CFRef) -> *const u8;
    /// Call the native CFMach Port Create Run Loop Source platform API.
    ///
    /// Args:
    ///     allocator (CFRef): Native allocator or the default allocator.
    ///     port (CFRef): Native event tap port.
    ///     order (isize): Native run-loop source order.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFMachPortCreateRunLoopSource(allocator: CFRef, port: CFRef, order: isize) -> CFRef;
    /// Call the native CFRun Loop Get Current platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CFRunLoopGetCurrent() -> CFRef;
    /// Call the native CFRun Loop Add Source platform API.
    ///
    /// Args:
    ///     run_loop (CFRef): Current native event run loop.
    ///     source (CFRef): Native source object or the default source.
    ///     mode (CFRef): Native run-loop scheduling mode.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CFRunLoopAddSource(run_loop: CFRef, source: CFRef, mode: CFRef);
    /// Call the native CFRun Loop Run platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: CFRef;
    static kCFBooleanTrue: CFRef;
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    /// Call the native CGPreflight Screen Capture Access platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CGPreflightScreenCaptureAccess() -> bool;
    /// Call the native CGPreflight Post Event Access platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CGPreflightPostEventAccess() -> bool;
    /// Call the native CGPreflight Listen Event Access platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CGPreflightListenEventAccess() -> bool;
    /// Call the native CGEvent Tap Create platform API.
    ///
    /// Args:
    ///     tap (u32): Native event tap location.
    ///     place (u32): Native event tap placement.
    ///     options (u32): Native operation option bits.
    ///     mask (u64): Observed native input event categories.
    ///     callback (unsafe extern "C" fn(*mut c_void, u32, CFRef, *mut c_void) -> CFRef, context: *mut c_void,): Read-only native input observer callback.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: unsafe extern "C" fn(*mut c_void, u32, CFRef, *mut c_void) -> CFRef,
        context: *mut c_void,
    ) -> CFRef;
    /// Call the native CGEvent Get Integer Value Field platform API.
    ///
    /// Args:
    ///     event (CFRef): Borrowed native input event.
    ///     field (u32): Native event field identifier.
    /// Returns:
    ///     i64: Native API result or status value.
    fn CGEventGetIntegerValueField(event: CFRef, field: u32) -> i64;
    /// Call the native CGWindow List Copy Window Info platform API.
    ///
    /// Args:
    ///     options (u32): Native operation option bits.
    ///     relative (u32): Relative native window identifier.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> CFRef;
    /// Call the native CGRect Make With Dictionary Representation platform API.
    ///
    /// Args:
    ///     value (CFRef): Native object or output value.
    ///     rectangle (*mut Rect): Native logical rectangle storage.
    /// Returns:
    ///     bool: Native API result or status value.
    fn CGRectMakeWithDictionaryRepresentation(value: CFRef, rectangle: *mut Rect) -> bool;
    /// Call the native CGGet Displays With Rect platform API.
    ///
    /// Args:
    ///     rectangle (Rect): Native logical rectangle storage.
    ///     capacity (u32): Caller-owned output element capacity.
    ///     displays (*mut u32): Output display identifiers.
    ///     count (*mut u32): Requested or returned native element count.
    /// Returns:
    ///     i32: Native API result or status value.
    fn CGGetDisplaysWithRect(
        rectangle: Rect,
        capacity: u32,
        displays: *mut u32,
        count: *mut u32,
    ) -> i32;
    /// Call the native CGDisplay Bounds platform API.
    ///
    /// Args:
    ///     display (u32): Native display identifier.
    /// Returns:
    ///     Rect: Native API result or status value.
    fn CGDisplayBounds(display: u32) -> Rect;
    /// Call the native CGDisplay Pixels Wide platform API.
    ///
    /// Args:
    ///     display (u32): Native display identifier.
    /// Returns:
    ///     usize: Native API result or status value.
    fn CGDisplayPixelsWide(display: u32) -> usize;
    /// Call the native CGEvent Create Mouse Event platform API.
    ///
    /// Args:
    ///     source (CFRef): Native source object or the default source.
    ///     kind (u32): Native object or event category.
    ///     position (Point): Native logical desktop position.
    ///     button (u32): Native mouse button identifier.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CGEventCreateMouseEvent(source: CFRef, kind: u32, position: Point, button: u32) -> CFRef;
    /// Call the native CGEvent Create platform API.
    ///
    /// Args:
    ///     source (CFRef): Native source object or the default source.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CGEventCreate(source: CFRef) -> CFRef;
    /// Call the native CGEvent Get Location platform API.
    ///
    /// Args:
    ///     event (CFRef): Borrowed native input event.
    /// Returns:
    ///     Point: Native API result or status value.
    fn CGEventGetLocation(event: CFRef) -> Point;
    /// Call the native CGEvent Create Keyboard Event platform API.
    ///
    /// Args:
    ///     source (CFRef): Native source object or the default source.
    ///     key (u16): Native property or keyboard key identifier.
    ///     down (bool): Whether a native key is pressed.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CGEventCreateKeyboardEvent(source: CFRef, key: u16, down: bool) -> CFRef;
    /// Call the native CGEvent Create Scroll Wheel Event platform API.
    ///
    /// Args:
    ///     source (CFRef): Native source object or the default source.
    ///     units (u32): Native wheel measurement units.
    ///     count (u32): Requested or returned native element count.
    ///     ... (native values): Axis deltas following the native wheel ABI.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn CGEventCreateScrollWheelEvent(source: CFRef, units: u32, count: u32, ...) -> CFRef;
    /// Call the native CGEvent Keyboard Set Unicode String platform API.
    ///
    /// Args:
    ///     event (CFRef): Borrowed native input event.
    ///     length (usize): Native text length or output length.
    ///     text (*const u16): Native string or text storage.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CGEventKeyboardSetUnicodeString(event: CFRef, length: usize, text: *const u16);
    /// Call the native CGEvent Set Flags platform API.
    ///
    /// Args:
    ///     event (CFRef): Borrowed native input event.
    ///     flags (u64): Native event modifier flags.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CGEventSetFlags(event: CFRef, flags: u64);
    /// Call the native CGEvent Set Integer Value Field platform API.
    ///
    /// Args:
    ///     event (CFRef): Borrowed native input event.
    ///     field (u32): Native event field identifier.
    ///     value (i64): Native object or output value.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CGEventSetIntegerValueField(event: CFRef, field: u32, value: i64);
    /// Call the native CGEvent Post platform API.
    ///
    /// Args:
    ///     tap (u32): Native event tap location.
    ///     event (CFRef): Borrowed native input event.
    /// Returns:
    ///     (): Completion of the native API call.
    fn CGEventPost(tap: u32, event: CFRef);
    static kCGWindowNumber: CFRef;
    static kCGWindowOwnerPID: CFRef;
    static kCGWindowOwnerName: CFRef;
    static kCGWindowName: CFRef;
    static kCGWindowBounds: CFRef;
    static kCGWindowLayer: CFRef;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    /// Call the native TISCopy Current Keyboard Layout Input Source platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CFRef;
    /// Call the native TISGet Input Source Property platform API.
    ///
    /// Args:
    ///     source (CFRef): Native source object or the default source.
    ///     key (CFRef): Native property or keyboard key identifier.
    /// Returns:
    ///     CFRef: Native object reference with platform-defined ownership.
    fn TISGetInputSourceProperty(source: CFRef, key: CFRef) -> CFRef;
    /// Call the native LMGet Kbd Type platform API.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     u8: Native API result or status value.
    fn LMGetKbdType() -> u8;
    /// Call the native UCKey Translate platform API.
    ///
    /// Args:
    ///     layout (*const c_void): Borrowed native keyboard layout data.
    ///     key (u16): Native property or keyboard key identifier.
    ///     action (u16): Native action identifier.
    ///     modifiers (u32): Native keyboard layout modifier state.
    ///     keyboard_type (u32): Current native physical keyboard type.
    ///     options (u32): Native operation option bits.
    ///     dead_state (*mut u32): Caller-owned native dead-key state.
    ///     capacity (u32): Caller-owned output element capacity.
    ///     length (*mut u32): Native text length or output length.
    ///     characters (*mut u16): Caller-owned translated character storage.
    /// Returns:
    ///     i32: Native API result or status value.
    fn UCKeyTranslate(
        layout: *const c_void,
        key: u16,
        action: u16,
        modifiers: u32,
        keyboard_type: u32,
        options: u32,
        dead_state: *mut u32,
        capacity: u32,
        length: *mut u32,
        characters: *mut u16,
    ) -> i32;
    static kTISPropertyUnicodeKeyLayoutData: CFRef;
}

/// Retained Core Foundation ownership released on every success and failure path.
struct Owned(CFRef);

impl Drop for Owned {
    /// Release one retained native object.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Completion of native ownership release.
    fn drop(&mut self) {
        // All wrappers own a Create or Copy result.
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

#[derive(Clone)]
struct WindowInfo {
    id: u32,
    pid: i32,
    title: String,
    owner: String,
    bounds: Rect,
    layer: i64,
}

#[derive(Clone, Copy)]
struct Transform {
    origin: Point,
    scale: f64,
}

struct Binding {
    pid: i32,
    window: u32,
    cancellation: Arc<AtomicU64>,
    capture: Option<(String, Vec<u8>)>,
}

static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
static HUMAN_GENERATION: AtomicU64 = AtomicU64::new(0);
static MONITOR_AVAILABLE: AtomicBool = AtomicBool::new(false);
static MONITOR_STARTED: OnceLock<bool> = OnceLock::new();

/// Return the private marker used to distinguish this agent's own posted events.
///
/// Args:
///     None.
/// Returns:
///     i64: Current-process native event marker.
fn event_marker() -> i64 {
    0x4142520000000000_i64 | i64::from(std::process::id())
}

/// Count external user input without reading or retaining keyboard content.
///
/// Args:
///     _proxy (*mut c_void): Native event-tap proxy.
///     kind (u32): Native input event category.
///     event (CFRef): Borrowed native event.
///     _context (*mut c_void): Unused event-tap context.
/// Returns:
///     CFRef: Original event unchanged by the read-only observer.
unsafe extern "C" fn input_monitor(
    _proxy: *mut c_void,
    kind: u32,
    event: CFRef,
    _context: *mut c_void,
) -> CFRef {
    // Disabled taps immediately invalidate injection admission until a fresh agent starts.
    if kind >= 0xfffffffe {
        MONITOR_AVAILABLE.store(false, Ordering::SeqCst);
    } else if !event.is_null()
        && unsafe { CGEventGetIntegerValueField(event, 42) } != event_marker()
    {
        HUMAN_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    event
}

/// Start a permission-gated read-only event tap on a dedicated native run-loop thread.
///
/// Args:
///     None.
/// Returns:
///     bool: Whether user-input interruption monitoring is active.
fn start_monitor() -> bool {
    *MONITOR_STARTED.get_or_init(|| {
        // Inspect TCC authorization without requesting a grant or changing system settings.
        if !unsafe { CGPreflightListenEventAccess() } {
            return false;
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mask = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 22, 25, 26, 27]
                .into_iter()
                .fold(0_u64, |mask, kind| mask | (1 << kind));
            let tap =
                Owned(unsafe { CGEventTapCreate(0, 0, 1, mask, input_monitor, ptr::null_mut()) });
            // Report unavailable monitoring when Quartz cannot create the event tap.
            if tap.0.is_null() {
                let _ = sender.send(false);
                return;
            }
            let source = Owned(unsafe { CFMachPortCreateRunLoopSource(ptr::null(), tap.0, 0) });
            // Abort monitor initialization when the event tap has no run-loop source.
            if source.0.is_null() {
                let _ = sender.send(false);
                return;
            }
            unsafe { CFRunLoopAddSource(CFRunLoopGetCurrent(), source.0, kCFRunLoopCommonModes) };
            MONITOR_AVAILABLE.store(true, Ordering::SeqCst);
            let _ = sender.send(true);
            unsafe { CFRunLoopRun() };
            MONITOR_AVAILABLE.store(false, Ordering::SeqCst);
        });
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or(false)
    }) && MONITOR_AVAILABLE.load(Ordering::SeqCst)
}

/// Detect the minimum macOS release required by the screenshot API.
///
/// Args:
///     None.
/// Returns:
///     bool: Whether the Darwin kernel corresponds to macOS 14 or later.
fn screenshot_supported() -> bool {
    let mut bytes = [0_u8; 64];
    let mut length = bytes.len();
    // Query stable kernel release metadata without launching a child process.
    let status = unsafe {
        sysctlbyname(
            c"kern.osrelease".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut length,
            ptr::null_mut(),
            0,
        )
    };
    // Treat an unsuccessful macOS version query as an unsupported capture platform.
    if status != 0 {
        return false;
    }
    let end = bytes
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end])
        .ok()
        .and_then(|value| value.split('.').next())
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|major| major >= 23)
}

/// Interrupt the current input operation from the authenticated IPC reader thread.
///
/// Args:
///     session_id (&str): Bound desktop session identifier.
/// Returns:
///     bool: Whether the session had a registered interruption generation.
pub fn interrupt(session_id: &str) -> bool {
    // Reader-side cancellation does not access thread-affine Accessibility objects.
    if let Some(lock) = CANCELLATIONS.get()
        && let Ok(values) = lock.lock()
        && let Some(flag) = values.get(session_id)
    {
        flag.fetch_add(1, Ordering::SeqCst);
        return true;
    }
    false
}

/// macOS desktop resources scoped to the authenticated process lifetime.
pub struct DesktopBackend {
    bindings: HashMap<String, Binding>,
    sequence: u64,
}

/// Classify a native observation error without exposing browser content.
///
/// Args:
///     _error (E): Native error excluded from protocol diagnostics.
/// Returns:
///     BackendError: Stable native error classification.
fn native_error<E>(_error: E) -> BackendError {
    BackendError::new("INTERNAL_ERROR", "Native desktop operation failed", true)
}

/// Read a required IPC string parameter.
///
/// Args:
///     params (&Value): Input parameter object.
///     name (&str): Required field name.
/// Returns:
///     Result<&str, BackendError>: Validated parameter value.
fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str, BackendError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            BackendError::new("INVALID_ARGUMENT", "A string parameter is required", false)
        })
}

/// Read a finite numeric IPC coordinate.
///
/// Args:
///     params (&Value): Input parameter object.
///     name (&str): Coordinate name.
/// Returns:
///     Result<f64, BackendError>: Finite coordinate value.
fn number(params: &Value, name: &str) -> Result<f64, BackendError> {
    params
        .get(name)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.abs() <= 1_000_000.0)
        .ok_or_else(|| {
            BackendError::new(
                "INVALID_ARGUMENT",
                "A finite input coordinate is required",
                false,
            )
        })
}

/// Construct an owned UTF-8 Core Foundation attribute string.
///
/// Args:
///     name (&str): Native attribute name.
/// Returns:
///     Result<Owned, BackendError>: Retained native string.
fn cf_string(name: &str) -> Result<Owned, BackendError> {
    let bytes = CString::new(name).map_err(native_error)?;
    let value = unsafe { CFStringCreateWithCString(ptr::null(), bytes.as_ptr(), 0x08000100) };
    // Reject failed Core Foundation string allocation before using the native handle.
    if value.is_null() {
        return Err(native_error(()));
    }
    Ok(Owned(value))
}

/// Copy an Accessibility attribute with owned native lifetime.
///
/// Args:
///     element (AXRef): Native accessibility element.
///     name (&str): Read-only attribute name.
/// Returns:
///     Result<Owned, BackendError>: Retained attribute value.
fn attribute(element: AXRef, name: &str) -> Result<Owned, BackendError> {
    let name = cf_string(name)?;
    let mut result = ptr::null();
    let code = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut result) };
    // Distinguish revoked TCC authorization from a missing optional attribute.
    if code != 0 || result.is_null() {
        return Err(BackendError::new(
            // Distinguish denied Accessibility authorization from an absent AX attribute.
            if code == -25211 {
                "PERMISSION_REQUIRED"
            } else {
                "TARGET_NOT_FOUND"
            },
            "Accessibility attribute is unavailable",
            true,
        ));
    }
    Ok(Owned(result))
}

/// Decode a bounded Core Foundation string or URL.
///
/// Args:
///     value (CFRef): Borrowed native attribute value.
/// Returns:
///     String: Bounded UTF-8 text or an empty value for other native types.
fn text(value: CFRef) -> String {
    // Represent an absent native string attribute with an empty value.
    if value.is_null() {
        return String::new();
    }
    let value = unsafe {
        // Extract the string representation of a Core Foundation URL attribute.
        if CFGetTypeID(value) == CFURLGetTypeID() {
            CFURLGetString(value)
        } else {
            value
        }
    };
    // Accept string conversion only for a live CFString reference.
    if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
        return String::new();
    }
    let mut bytes = vec![0_u8; 16385];
    // A fixed buffer prevents unbounded allocation for native accessible values.
    if !unsafe {
        CFStringGetCString(
            value,
            bytes.as_mut_ptr().cast(),
            bytes.len() as isize,
            0x08000100,
        )
    } {
        return String::new();
    }
    let length = bytes
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..length]).into_owned()
}

/// Read a signed number from a native window dictionary.
///
/// Args:
///     dictionary (CFRef): Borrowed Core Graphics window dictionary.
///     key (CFRef): Native dictionary key.
/// Returns:
///     i64: Numeric value with a zero default for absent metadata.
fn dictionary_number(dictionary: CFRef, key: CFRef) -> i64 {
    let value = unsafe { CFDictionaryGetValue(dictionary, key) };
    let mut number = 0_i64;
    // Decode window numeric metadata only when its dictionary value exists.
    if !value.is_null() {
        unsafe { CFNumberGetValue(value, 4, (&mut number as *mut i64).cast()) };
    }
    number
}

/// Enumerate on-screen native windows in actual front-to-back stacking order.
///
/// Args:
///     None.
/// Returns:
///     Result<Vec<WindowInfo>, BackendError>: Native window metadata.
fn windows() -> Result<Vec<WindowInfo>, BackendError> {
    let list = Owned(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) });
    // Reject a missing Quartz window list before inspecting window records.
    if list.0.is_null() {
        return Err(native_error(()));
    }
    // Require complete native window enumeration before proving geometry uniqueness.
    if unsafe { CFArrayGetCount(list.0) } > 2048 {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Native window list exceeds its complete-observation quota",
            false,
        ));
    }
    let mut output = Vec::new();
    // Use the operating system's ownership metadata instead of window titles as identity.
    for index in 0..unsafe { CFArrayGetCount(list.0) }.min(2048) {
        let dictionary = unsafe { CFArrayGetValueAtIndex(list.0, index) };
        let mut bounds = Rect::default();
        let value = unsafe { CFDictionaryGetValue(dictionary, kCGWindowBounds) };
        // Reject incomplete native bounds before asserting complete window enumeration.
        if value.is_null() || !unsafe { CGRectMakeWithDictionaryRepresentation(value, &mut bounds) }
        {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Native window geometry is incomplete",
                true,
            ));
        }
        output.push(WindowInfo {
            id: dictionary_number(dictionary, unsafe { kCGWindowNumber }) as u32,
            pid: dictionary_number(dictionary, unsafe { kCGWindowOwnerPID }) as i32,
            title: text(unsafe { CFDictionaryGetValue(dictionary, kCGWindowName) }),
            owner: text(unsafe { CFDictionaryGetValue(dictionary, kCGWindowOwnerName) }),
            layer: dictionary_number(dictionary, unsafe { kCGWindowLayer }),
            bounds,
        });
    }
    Ok(output)
}

/// Identify native Chromium window-owner names for unfiltered candidate enumeration.
///
/// Args:
///     window (&WindowInfo): Native process and window metadata.
/// Returns:
///     bool: Whether the owner identifies a supported Chromium application.
fn browser(window: &WindowInfo) -> bool {
    matches!(
        window.owner.as_str(),
        "Google Chrome" | "Google Chrome for Testing" | "Chromium" | "ABR Chromium"
    )
}

/// Require unique native Core Graphics geometry before linking an Accessibility window.
///
/// Args:
///     window (&WindowInfo): Exact PID and CGWindowID of the bound browser.
/// Returns:
///     Result<(), BackendError>: Unique same-process native geometry or a closed identity gate.
fn unique_native_geometry(window: &WindowInfo) -> Result<(), BackendError> {
    let candidates = windows()?;
    let matches: Vec<(String, Option<bool>)> = candidates
        .iter()
        .filter(|value| value.pid == window.pid && value.layer == 0 && browser(value))
        .map(|value| {
            (
                value.id.to_string(),
                Some(
                    (value.bounds.origin.x - window.bounds.origin.x).abs() <= 2.0
                        && (value.bounds.origin.y - window.bounds.origin.y).abs() <= 2.0
                        && (value.bounds.size.width - window.bounds.size.width).abs() <= 2.0
                        && (value.bounds.size.height - window.bounds.size.height).abs() <= 2.0,
                ),
            )
        })
        .collect();
    unique_bound_window_index(&matches, &window.id.to_string())?;
    Ok(())
}

/// Determine a Retina transform for a window entirely on one display.
///
/// Args:
///     rectangle (Rect): Core Graphics logical window rectangle.
/// Returns:
///     Result<Transform, BackendError>: Explicit display-local physical mapping.
fn transform(rectangle: Rect) -> Result<Transform, BackendError> {
    let mut displays = [0_u32; 16];
    let mut count = 0;
    let result = unsafe { CGGetDisplaysWithRect(rectangle, 16, displays.as_mut_ptr(), &mut count) };
    // Reject mixed-scale display crossings until a piecewise transform is available.
    if result != 0 || count != 1 {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Window must occupy one display for verified Retina coordinates",
            false,
        ));
    }
    let bounds = unsafe { CGDisplayBounds(displays[0]) };
    let scale = unsafe { CGDisplayPixelsWide(displays[0]) } as f64 / bounds.size.width;
    // Require a finite display scale within the supported coordinate-transform range.
    if !scale.is_finite() || !(0.5..=4.0).contains(&scale) {
        return Err(native_error(()));
    }
    Ok(Transform {
        origin: bounds.origin,
        scale,
    })
}

impl Transform {
    /// Convert a Core Graphics logical point to display-local physical coordinates.
    ///
    /// Args:
    ///     point (Point): Logical desktop point.
    /// Returns:
    ///     Point: Explicit physical desktop point.
    fn physical(self, point: Point) -> Point {
        Point {
            x: self.origin.x + (point.x - self.origin.x) * self.scale,
            y: self.origin.y + (point.y - self.origin.y) * self.scale,
        }
    }

    /// Convert a verified physical point to Quartz logical coordinates.
    ///
    /// Args:
    ///     point (Point): Display-local physical desktop point.
    /// Returns:
    ///     Point: Logical Quartz desktop point.
    fn logical(self, point: Point) -> Point {
        Point {
            x: self.origin.x + (point.x - self.origin.x) / self.scale,
            y: self.origin.y + (point.y - self.origin.y) / self.scale,
        }
    }

    /// Convert a native rectangle to explicit screen-physical geometry.
    ///
    /// Args:
    ///     rectangle (Rect): Native logical rectangle.
    /// Returns:
    ///     Value: Physical rectangle with coordinate-space declaration.
    fn rectangle(self, rectangle: Rect) -> Value {
        let point = self.physical(rectangle.origin);
        json!({"x":point.x,"y":point.y,"width":rectangle.size.width*self.scale,
            "height":rectangle.size.height*self.scale,"space":"screen-physical"})
    }
}

/// Read an Accessibility element's logical position and size.
///
/// Args:
///     element (AXRef): Native accessibility element.
/// Returns:
///     Option<Rect>: Observed native rectangle.
fn ax_bounds(element: AXRef) -> Option<Rect> {
    let position = attribute(element, "AXPosition").ok()?;
    let size = attribute(element, "AXSize").ok()?;
    let mut result = Rect::default();
    // Expose AX bounds only when native position and size decode to positive dimensions.
    if unsafe { AXValueGetValue(position.0, 1, (&mut result.origin as *mut Point).cast()) }
        && unsafe { AXValueGetValue(size.0, 2, (&mut result.size as *mut Size).cast()) }
        && result.size.width > 0.0
        && result.size.height > 0.0
    {
        Some(result)
    } else {
        None
    }
}

/// Find an application AX window whose geometry matches its CGWindow identifier.
///
/// Args:
///     application (AXRef): Retained process accessibility application.
///     bounds (Rect): Independently obtained Core Graphics window rectangle.
/// Returns:
///     Result<Owned, BackendError>: Owned window array retaining a selected borrowed element.
fn ax_windows(application: AXRef, bounds: Rect) -> Result<(Owned, AXRef), BackendError> {
    let list = attribute(application, "AXWindows")?;
    // Require a complete bounded native array before considering matching window geometry.
    if list.0.is_null()
        || !unsafe { CFGetTypeID(list.0) == CFArrayGetTypeID() }
        || unsafe { CFArrayGetCount(list.0) } > 64
    {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Native window list is incomplete or exceeds limits",
            false,
        ));
    }
    let mut candidates = Vec::new();
    let mut matches = Vec::new();
    // Match exact native geometry instead of relying on duplicated page titles.
    for index in 0..unsafe { CFArrayGetCount(list.0) }.min(64) {
        let window = unsafe { CFArrayGetValueAtIndex(list.0, index) };
        // Select the AX window whose origin and size match the bound Quartz window.
        let matching = ax_bounds(window).map(|value| {
            (value.origin.x - bounds.origin.x).abs() <= 2.0
                && (value.origin.y - bounds.origin.y).abs() <= 2.0
                && (value.size.width - bounds.size.width).abs() <= 2.0
                && (value.size.height - bounds.size.height).abs() <= 2.0
        });
        candidates.push(window);
        matches.push(matching);
    }
    let selected = unique_window_index(&matches)?;
    Ok((list, candidates[selected]))
}

impl DesktopBackend {
    /// Initialize bounded desktop resources without requesting TCC authorization.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Result<Self, BackendError>: Backend capable of permission diagnostics.
    pub fn new() -> Result<Self, BackendError> {
        start_monitor();
        Ok(Self {
            bindings: HashMap::new(),
            sequence: 0,
        })
    }

    /// Dispatch authenticated native desktop operations.
    ///
    /// Args:
    ///     method (&str): Shared desktop IPC method.
    ///     params (&Value): Validated outer parameter object.
    /// Returns:
    ///     Result<Value, BackendError>: Native result with explicit capability errors.
    pub fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, BackendError> {
        // Route authenticated methods to the platform observer, capture, input, or lifecycle handler.
        match method {
            "desktop.browserVersion" => browser_version(params),
            "desktop.doctor" => Ok(json!({"platform":"macos","schemaVersion":1,
                "accessibility":unsafe{AXIsProcessTrusted()},"screenCapture":unsafe{CGPreflightScreenCaptureAccess()}&&screenshot_supported(),
                "input":unsafe{AXIsProcessTrusted()&&CGPreflightPostEventAccess()}&&MONITOR_AVAILABLE.load(Ordering::SeqCst),"atomicNavigate":false,"foregroundValidation":unsafe{AXIsProcessTrusted()},
                "userInputMonitoring":MONITOR_AVAILABLE.load(Ordering::SeqCst),
                "captureBackend":"screencapturekit","minimumVersion":"14.0","ime":false,"reason":
                    // Explain missing TCC grants separately from an inactive user-input monitor.
                    if !unsafe{AXIsProcessTrusted()&&CGPreflightPostEventAccess()&&CGPreflightListenEventAccess()}{"PERMISSION_REQUIRED"}
                    else if !MONITOR_AVAILABLE.load(Ordering::SeqCst){"INPUT_BACKEND_UNAVAILABLE"}else{"AVAILABLE"},
                "permissions":{"accessibility":unsafe{AXIsProcessTrusted()},"screenRecording":unsafe{CGPreflightScreenCaptureAccess()},
                    "postEvents":unsafe{CGPreflightPostEventAccess()},"listenEvents":unsafe{CGPreflightListenEventAccess()}},"permissionAction":"System Settings > Privacy & Security > Accessibility, Input Monitoring and Screen Recording; restart the agent after authorization"})),
            "desktop.listWindows" => {
                let pid = params.get("pid").and_then(Value::as_i64);
                let mut output = Vec::new();
                // Inspect the current on-screen windows in Quartz stacking order.
                for window in windows()? {
                    // Retain browser windows on the normal layer that match the optional trusted PID.
                    if window.layer != 0
                        || !browser(&window)
                        || pid.is_some_and(|value| value != i64::from(window.pid))
                    {
                        continue;
                    }
                    let mapping = transform(window.bounds)?;
                    output.push(json!({"windowId":window.id.to_string(),"pid":window.pid,"title":window.title,
                        "bounds":mapping.rectangle(window.bounds),"scale":mapping.scale,"foreground":self.foreground(&window).is_ok()}));
                }
                Ok(json!(output))
            }
            "desktop.bind" => self.bind(params),
            "desktop.unbind" => {
                let session = string(params, "sessionId")?;
                self.bindings.remove(session);
                // Remove the unbound session from the shared cancellation registry.
                if let Ok(mut values) = CANCELLATIONS
                    .get_or_init(|| Mutex::new(HashMap::new()))
                    .lock()
                {
                    values.remove(session);
                }
                Ok(json!({"unbound":true}))
            }
            "desktop.observe" => self.observe(params),
            "desktop.currentUrl" => self
                .observe(params)
                .map(|value| json!({"url":value["url"]})),
            "desktop.focus" => self.focus(params),
            "desktop.input" => self.input(params),
            "desktop.capture" => self.capture(params),
            "desktop.readCapture" => self.read_capture(params),
            "desktop.cancel" => {
                interrupt(string(params, "sessionId")?);
                Ok(json!({"cancelled":true}))
            }
            _ => Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Desktop method is unavailable",
                false,
            )),
        }
    }

    /// Bind a trusted browser launch process to its verified native window identifier.
    ///
    /// Args:
    ///     params (&Value): Session identifier, trusted PID, and native window identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Verified ownership acknowledgement.
    fn bind(&mut self, params: &Value) -> Result<Value, BackendError> {
        let session = string(params, "sessionId")?.to_owned();
        let window: u32 = string(params, "windowId")?.parse().map_err(native_error)?;
        let pid = params
            .get("pid")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| {
                BackendError::new(
                    "INVALID_ARGUMENT",
                    "A process identifier is required",
                    false,
                )
            })?;
        // Native window metadata establishes process ownership before input admission.
        let selected = windows()?
            .into_iter()
            .find(|value| {
                value.id == window && value.pid == pid && value.layer == 0 && browser(value)
            })
            .ok_or_else(|| {
                BackendError::new(
                    "POLICY_DENIED",
                    "Native window does not belong to the browser process",
                    false,
                )
            })?;
        self.permission()?;
        unique_native_geometry(&selected)?;
        let application = Owned(unsafe { AXUIElementCreateApplication(pid) });
        // Establish unique native AX window geometry before any session ownership is recorded.
        if application.0.is_null() {
            return Err(native_error(()));
        }
        // Bound the initial native AX window query by the same per-call timeout used for observations.
        unsafe { AXUIElementSetMessagingTimeout(application.0, 1.0) };
        ax_windows(application.0, selected.bounds)?;
        // Enforce the active binding quota while permitting updates to an existing session.
        if self.bindings.len() >= 16 && !self.bindings.contains_key(&session) {
            return Err(BackendError::new(
                "DESKTOP_BUSY",
                "Desktop binding quota is reached",
                true,
            ));
        }
        let cancellation = Arc::new(AtomicU64::new(0));
        CANCELLATIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(native_error)?
            .insert(session.clone(), cancellation.clone());
        self.bindings.insert(
            session,
            Binding {
                pid,
                window,
                cancellation,
                capture: None,
            },
        );
        Ok(json!({"bound":true,"windowId":window.to_string(),"pid":pid}))
    }

    /// Revalidate the process association of a previously bound native window.
    ///
    /// Args:
    ///     params (&Value): Session identifier.
    /// Returns:
    ///     Result<(&Binding, WindowInfo), BackendError>: Live binding and native metadata.
    fn binding(&self, params: &Value) -> Result<(&Binding, WindowInfo), BackendError> {
        let binding = self
            .bindings
            .get(string(params, "sessionId")?)
            .ok_or_else(|| {
                BackendError::new("SESSION_NOT_FOUND", "Desktop session is absent", false)
            })?;
        let window = windows()?
            .into_iter()
            .find(|value| value.id == binding.window && value.pid == binding.pid && browser(value))
            .ok_or_else(|| {
                BackendError::new(
                    "BROWSER_DISCONNECTED",
                    "Native browser window is absent",
                    false,
                )
            })?;
        unique_native_geometry(&window)?;
        Ok((binding, window))
    }

    /// Require user-granted Accessibility authorization before observation or input.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Result<(), BackendError>: Accessibility permission validation.
    fn permission(&self) -> Result<(), BackendError> {
        // Require the native Accessibility grant before reading or focusing browser windows.
        if !unsafe { AXIsProcessTrusted() } {
            return Err(BackendError::new(
                "PERMISSION_REQUIRED",
                "Grant Accessibility access in System Settings",
                true,
            ));
        }
        Ok(())
    }

    /// Validate the focused application PID and its focused AX window geometry.
    ///
    /// Args:
    ///     window (&WindowInfo): Verified bound native browser window.
    /// Returns:
    ///     Result<(), BackendError>: Foreground identity validation.
    fn foreground(&self, window: &WindowInfo) -> Result<(), BackendError> {
        self.permission()?;
        unique_native_geometry(window)?;
        let system = Owned(unsafe { AXUIElementCreateSystemWide() });
        // Reject failure to create the system-wide AX focus observer.
        if system.0.is_null() {
            return Err(native_error(()));
        }
        unsafe { AXUIElementSetMessagingTimeout(system.0, 1.0) };
        let application = attribute(system.0, "AXFocusedApplication")?;
        let mut pid = 0;
        // Require the currently focused application PID to equal the bound browser PID.
        if unsafe { AXUIElementGetPid(application.0, &mut pid) } != 0 || pid != window.pid {
            return Err(BackendError::new(
                "FOCUS_LOST",
                "Browser process is not foreground",
                true,
            ));
        }
        let focused = attribute(application.0, "AXFocusedWindow")?;
        let (_windows, selected) = ax_windows(application.0, window.bounds)?;
        // Require the focused AX object to be the uniquely associated native window.
        if !unsafe { CFEqual(focused.0, selected) } {
            return Err(BackendError::new(
                "FOCUS_LOST",
                "A different native AX window is focused",
                true,
            ));
        }
        let bounds = ax_bounds(focused.0).ok_or_else(|| native_error(()))?;
        // Require the focused AX window rectangle to match the bound Quartz window.
        if (bounds.origin.x - window.bounds.origin.x).abs() > 2.0
            || (bounds.origin.y - window.bounds.origin.y).abs() > 2.0
            || (bounds.size.width - window.bounds.size.width).abs() > 2.0
            || (bounds.size.height - window.bounds.size.height).abs() > 2.0
        {
            return Err(BackendError::new(
                "FOCUS_LOST",
                "A different browser window is focused",
                true,
            ));
        }
        Ok(())
    }

    /// Activate a bound browser window through the operating-system focus interfaces.
    ///
    /// Args:
    ///     params (&Value): Bound session identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Independently verified focus acknowledgement.
    fn focus(&self, params: &Value) -> Result<Value, BackendError> {
        // Foreground changes share the cross-agent desktop input seat.
        let _lease = DesktopLease::acquire()?;
        self.permission()?;
        let (_, window) = self.binding(params)?;
        let application = Owned(unsafe { AXUIElementCreateApplication(window.pid) });
        // Reject failure to create the browser application AX reference before focus changes.
        if application.0.is_null() {
            return Err(native_error(()));
        }
        unsafe { AXUIElementSetMessagingTimeout(application.0, 1.0) };
        let (_windows, selected) = ax_windows(application.0, window.bounds)?;
        let frontmost = cf_string("AXFrontmost")?;
        let raise = cf_string("AXRaise")?;
        // Focus operations target application windows; browser control activation uses Quartz input.
        if unsafe { AXUIElementSetAttributeValue(application.0, frontmost.0, kCFBooleanTrue) } != 0
            || unsafe { AXUIElementPerformAction(selected, raise.0) } != 0
        {
            return Err(BackendError::new(
                "FOCUS_LOST",
                "System did not activate browser window",
                true,
            ));
        }
        let started = Instant::now();
        // Process native state until the bounded operation or connection completes.
        while started.elapsed() < Duration::from_millis(750) {
            // Finish the focus wait only after the bound native browser window is confirmed.
            if self.foreground(&window).is_ok() {
                return Ok(json!({"focused":true}));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(BackendError::new(
            "FOCUS_LOST",
            "Browser focus was not confirmed",
            true,
        ))
    }

    /// Read a bounded, redacted AX tree and current document URL.
    ///
    /// Args:
    ///     params (&Value): Bound session identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Native accessibility observation and explicit geometry.
    fn observe(&self, params: &Value) -> Result<Value, BackendError> {
        self.permission()?;
        let (_, window) = self.binding(params)?;
        let mapping = transform(window.bounds)?;
        let application = Owned(unsafe { AXUIElementCreateApplication(window.pid) });
        // Require a live browser AX application reference before observing its window.
        if application.0.is_null() {
            return Err(native_error(()));
        }
        unsafe { AXUIElementSetMessagingTimeout(application.0, 1.0) };
        let (_windows, selected) = ax_windows(application.0, window.bounds)?;
        let started = Instant::now();
        // Resolve origin and document geometry through private native metadata before redaction.
        let (private_before, retained_before) =
            read_url_metadata(selected, mapping, window.pid, started)?;
        let before = trusted_browser_url(&private_before, UrlPlatform::Mac)?;
        let viewport =
            document_geometry(&private_before, UrlPlatform::Mac, &before).ok_or_else(|| {
                BackendError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "Native viewport geometry is unavailable",
                    false,
                )
            })?;
        let mut count = 0;
        let mut seen = HashSet::new();
        let patterns = sensitive_patterns(params);
        let root = read_node(
            selected, mapping, 0, &mut count, &mut seen, started, &patterns,
        )?;
        // Require stable native objects and origin after reading the public privacy tree.
        let (private_after, retained_after) =
            read_url_metadata(selected, mapping, window.pid, started)?;
        let after = trusted_browser_url(&private_after, UrlPlatform::Mac)?;
        consistent_browser_url(&before, &after)?;
        // Require stable document geometry around the public privacy-tree read.
        if document_geometry(&private_after, UrlPlatform::Mac, &after) != Some(viewport) {
            return Err(BackendError::new(
                "TARGET_STALE",
                "Native document geometry changed",
                true,
            ));
        }
        for identity in [&before.window_id, &before.source_id]
            .into_iter()
            .chain(before.document_id.iter())
        {
            let first = retained_before
                .get(identity)
                .ok_or_else(|| native_error(()))?;
            let second = retained_after
                .get(identity)
                .ok_or_else(|| native_error(()))?;
            // Compare retained AX objects directly so native hash collisions cannot confer identity.
            if !unsafe { CFEqual(first.0, second.0) } {
                return Err(BackendError::new(
                    "TARGET_STALE",
                    "Native URL source object changed",
                    true,
                ));
            }
        }
        let (_, current) = self.binding(params)?;
        let current_mapping = transform(current.bounds)?;
        // Keep physical window geometry and monitor transform stable around the private reads.
        if current_mapping.rectangle(current.bounds) != mapping.rectangle(window.bounds)
            || current_mapping.scale != mapping.scale
        {
            return Err(BackendError::new(
                "TARGET_STALE",
                "Browser window geometry changed",
                true,
            ));
        }
        let url = before.url;
        let origin = mapping.physical(window.bounds.origin);
        Ok(
            json!({"windowId":window.id.to_string(),"root":root,"url":url,
            "scale":{"dpr":mapping.scale,"zoom":1},"geometry":{"windowOrigin":{"x":origin.x,"y":origin.y},
                "viewportOrigin":{"x":viewport["x"],"y":viewport["y"]},"monitorScale":mapping.scale,"viewportMetricsVerified":false}}),
        )
    }

    /// Validate deadline, cancellation, foreground identity, and event-posting permission.
    ///
    /// Args:
    ///     binding (&Binding): Session cancellation state.
    ///     window (&WindowInfo): Bound native window.
    ///     generation ((u64, u64)): Cancellation and user-input generations at action start.
    ///     started (Instant): Action start time.
    ///     timeout (Duration): Action deadline.
    /// Returns:
    ///     Result<(), BackendError>: Admission to the next native input event.
    fn checkpoint(
        &self,
        binding: &Binding,
        window: &WindowInfo,
        generation: (u64, u64),
        started: Instant,
        timeout: Duration,
    ) -> Result<(), BackendError> {
        // Interrupt input when cancellation, external input, or the action deadline changes.
        if binding.cancellation.load(Ordering::SeqCst) != generation.0
            || HUMAN_GENERATION.load(Ordering::SeqCst) != generation.1
            || started.elapsed() >= timeout
        {
            return Err(BackendError::new(
                "TIMEOUT",
                "Desktop input was interrupted or expired",
                false,
            ));
        }
        // Require an active event tap before admitting additional injected input.
        if !MONITOR_AVAILABLE.load(Ordering::SeqCst) {
            return Err(BackendError::new(
                // Differentiate a missing monitoring grant from a failed authorized event tap.
                if unsafe { CGPreflightListenEventAccess() } {
                    "INPUT_BACKEND_UNAVAILABLE"
                } else {
                    "PERMISSION_REQUIRED"
                },
                "User-input monitoring authorization and an active event tap are required",
                true,
            ));
        }
        // Require event-posting authorization before every native input batch.
        if !unsafe { CGPreflightPostEventAccess() } {
            return Err(BackendError::new(
                "PERMISSION_REQUIRED",
                "Grant event-posting Accessibility access in System Settings",
                true,
            ));
        }
        self.foreground(window)
    }

    /// Dispatch paired Quartz pointer or keyboard input to a verified foreground window.
    ///
    /// Args:
    ///     params (&Value): Shared input request and screen-physical coordinates.
    /// Returns:
    ///     Result<Value, BackendError>: Actual physical-key or Unicode execution strategy.
    fn input(&self, params: &Value) -> Result<Value, BackendError> {
        // Serialize native input across independently launched runtime Agents.
        let _lease = DesktopLease::acquire()?;
        let (binding, window) = self.binding(params)?;
        let generation = (
            binding.cancellation.load(Ordering::SeqCst),
            HUMAN_GENERATION.load(Ordering::SeqCst),
        );
        let started = Instant::now();
        let timeout = Duration::from_millis(
            params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(30_000)
                .clamp(1, 120_000),
        );
        self.checkpoint(binding, &window, generation, started, timeout)?;
        let mapping = transform(window.bounds)?;
        let kind = string(params, "kind")?;
        let mut strategy = "os-keyboard";
        // Select the paired pointer, scroll, keyboard, or text submission implementation.
        match kind {
            "move" | "click" | "doubleClick" | "drag" => {
                let point = mapping.logical(Point {
                    x: number(params, "x")?,
                    y: number(params, "y")?,
                });
                hit_test(&window, point)?;
                let endpoint = if kind == "drag" {
                    Some(mapping.logical(Point {
                        x: number(params, "endX")?,
                        y: number(params, "endY")?,
                    }))
                } else {
                    None
                };
                // Validate the drag endpoint against the bound window before pressing a button.
                if let Some(point) = endpoint {
                    hit_test(&window, point)?;
                }
                let button = match params
                    .get("button")
                    .and_then(Value::as_str)
                    .unwrap_or("left")
                {
                    "left" => 0,
                    "right" => 1,
                    "middle" => 2,
                    _ => {
                        return Err(BackendError::new(
                            "INVALID_ARGUMENT",
                            "Mouse button is invalid",
                            false,
                        ));
                    }
                };
                let (down, up, drag) = match button {
                    0 => (1, 2, 6),
                    1 => (3, 4, 7),
                    _ => (25, 26, 27),
                };
                mouse(5, point, button, 0)?;
                // Add paired button transitions for clicks and drags after the pointer move.
                if kind != "move" {
                    let clicks = if kind == "doubleClick" { 2 } else { 1 };
                    // Post each click with fresh cancellation and native hit-test validation.
                    for click in 1..=clicks {
                        self.checkpoint(binding, &window, generation, started, timeout)?;
                        hit_test(&window, point)?;
                        mouse(down, point, button, click)?;
                        let result = if let Some(end) = endpoint {
                            self.checkpoint(binding, &window, generation, started, timeout)
                                .and_then(|()| hit_test(&window, end))
                                .and_then(|()| mouse(drag, end, button, click))
                        } else {
                            Ok(())
                        };
                        // Release the accepted button independently of current focus or cancellation.
                        let release = mouse(up, endpoint.unwrap_or(point), button, click);
                        result?;
                        release?;
                    }
                }
            }
            "scroll" => {
                let pointer = Owned(unsafe { CGEventCreate(ptr::null()) });
                // Require a native pointer event before resolving the current wheel target.
                if pointer.0.is_null() {
                    return Err(native_error(()));
                }
                hit_test(&window, unsafe { CGEventGetLocation(pointer.0) })?;
                let dx = number(params, "deltaX")?.round().clamp(-12_000.0, 12_000.0) as i32;
                let dy = number(params, "deltaY")?.round().clamp(-12_000.0, 12_000.0) as i32;
                // Quartz pixel wheel deltas use the opposite sign from the public downward-positive convention.
                let event =
                    Owned(unsafe { CGEventCreateScrollWheelEvent(ptr::null(), 0, 2, -dy, -dx) });
                post(event)?;
            }
            "key" => {
                let (code, flags) = key_chord(string(params, "key")?)?;
                self.checkpoint(binding, &window, generation, started, timeout)?;
                key_pair(code, flags, None)?;
            }
            "text" => {
                let requested = params
                    .get("strategy")
                    .and_then(Value::as_str)
                    .unwrap_or("auto");
                // Return the explicit unsupported capability result for IME composition.
                if requested == "ime" {
                    return Err(BackendError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "System IME composition is unavailable",
                        false,
                    ));
                }
                // Restrict text submission to the declared auto, Unicode, or keyboard strategies.
                if !matches!(requested, "auto" | "unicode" | "keyboard") {
                    return Err(BackendError::new(
                        "INVALID_ARGUMENT",
                        "Text strategy is invalid",
                        false,
                    ));
                }
                let value = string(params, "text")?;
                // Bound the text batch by Unicode character count before posting native events.
                if value.chars().count() > 4096 {
                    return Err(BackendError::new(
                        "INVALID_ARGUMENT",
                        "Text input quota exceeded",
                        false,
                    ));
                }
                // Resolve physical text submission against the current native keyboard layout.
                if requested == "keyboard" {
                    let mut keys = Vec::new();
                    // Resolve the entire input against the active layout before injecting any character.
                    for character in value.chars() {
                        self.checkpoint(binding, &window, generation, started, timeout)?;
                        keys.push(match character {
                            '\n' => (36, false),
                            '\t' => (48, false),
                            _ => layout_key(character)?,
                        });
                    }
                    // Post the prevalidated physical keys with the required Shift flag and paired release.
                    for (code, shift) in keys {
                        self.checkpoint(binding, &window, generation, started, timeout)?;
                        key_pair(code, if shift { 1 << 17 } else { 0 }, None)?;
                    }
                } else {
                    strategy = "os-unicode";
                    // Submit each Unicode scalar as a bounded UTF-16 down and up event pair.
                    for character in value.chars() {
                        self.checkpoint(binding, &window, generation, started, timeout)?;
                        let mut buffer = [0_u16; 2];
                        let units = character.encode_utf16(&mut buffer);
                        key_pair(0, 0, Some(units))?;
                    }
                }
            }
            _ => {
                return Err(BackendError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "Input kind is unavailable",
                    false,
                ));
            }
        }
        Ok(json!({"executed":true,"actualStrategy":strategy}))
    }

    /// Capture an owned native window and redact protected AX rectangles in memory.
    ///
    /// Args:
    ///     params (&Value): Bound desktop session identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Opaque bounded redacted PNG descriptor.
    fn capture(&mut self, params: &Value) -> Result<Value, BackendError> {
        // Keep unsupported platform versions separate from TCC authorization failures.
        if !screenshot_supported() {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "ScreenCaptureKit screenshots require macOS 14 or later",
                false,
            ));
        }
        // Require the Screen Recording grant before acquiring browser image data.
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(BackendError::new(
                "PERMISSION_REQUIRED",
                "Grant Screen Recording access in System Settings",
                true,
            ));
        }
        let observation = self.observe(params)?;
        require_mask_geometry(&observation["root"])?;
        let (_, window) = self.binding(params)?;
        let mapping = transform(window.bounds)?;
        let width = (window.bounds.size.width * mapping.scale).round() as u32;
        let height = (window.bounds.size.height * mapping.scale).round() as u32;
        // Reject empty or oversized browser capture dimensions before allocating pixels.
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Window capture dimensions exceed limits",
                false,
            ));
        }
        // ScreenCaptureKit validates native window ownership and retains the OS capture authorization.
        let content = SCShareableContent::get().map_err(native_error)?;
        let selected = content
            .windows()
            .into_iter()
            .find(|value| {
                value.window_id() == window.id
                    && value
                        .owning_application()
                        .is_some_and(|application| application.process_id() == window.pid)
            })
            .ok_or_else(|| {
                BackendError::new(
                    "BROWSER_DISCONNECTED",
                    "ScreenCaptureKit window ownership changed",
                    false,
                )
            })?;
        let filter = SCContentFilter::create()
            .with_window(&selected)
            .build()
            .map_err(native_error)?;
        let configuration = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_shows_cursor(false)
            .with_ignores_shadows_single_window(true)
            .map_err(native_error)?;
        let image =
            SCScreenshotManager::capture_image(&filter, &configuration).map_err(native_error)?;
        let mut pixels = image.rgba_data().map_err(native_error)?;
        // Require the decoded capture length to match its exact RGBA dimensions.
        if pixels.len() != width as usize * height as usize * 4 {
            return Err(native_error(()));
        }
        let after = self.observe(params)?;
        require_mask_geometry(&after["root"])?;
        // Retain bytes inside the agent when authorized browser origin changed during capture.
        if after["url"] != observation["url"] {
            return Err(BackendError::new(
                "TARGET_STALE",
                "Browser URL changed during capture",
                true,
            ));
        }
        let origin = mapping.physical(window.bounds.origin);
        mask_rectangles(
            &mut pixels,
            width as usize,
            height as usize,
            origin,
            &observation["root"],
        );
        mask_rectangles(
            &mut pixels,
            width as usize,
            height as usize,
            origin,
            &after["root"],
        );
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .map_err(native_error)?
                .write_image_data(&pixels)
                .map_err(native_error)?;
        }
        // Bound the encoded PNG before storing transferable capture bytes.
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Capture byte quota exceeded",
                false,
            ));
        }
        self.sequence = self.sequence.wrapping_add(1);
        let id = format!("capture-{}", self.sequence);
        let length = bytes.len();
        self.bindings
            .get_mut(string(params, "sessionId")?)
            .ok_or_else(|| native_error(()))?
            .capture = Some((id.clone(), bytes));
        Ok(
            json!({"captureId":id,"length":length,"mimeType":"image/png","width":width,"height":height}),
        )
    }

    /// Transfer a bounded chunk of an already redacted session-owned capture.
    ///
    /// Args:
    ///     params (&Value): Session, capture identifier, offset, and maximum byte count.
    /// Returns:
    ///     Result<Value, BackendError>: Bounded Base64 image chunk.
    fn read_capture(&self, params: &Value) -> Result<Value, BackendError> {
        let (binding, _) = self.binding(params)?;
        let (_, bytes) = binding
            .capture
            .as_ref()
            .filter(|(id, _)| params.get("captureId").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| BackendError::new("TARGET_NOT_FOUND", "Capture is absent", false))?;
        let offset = params
            .get("offset")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| {
                BackendError::new("INVALID_ARGUMENT", "Capture offset is required", false)
            })?;
        let maximum = params
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(524288)
            .min(524288) as usize;
        // Require a valid capture offset and a positive requested chunk size.
        if offset > bytes.len() || maximum == 0 {
            return Err(BackendError::new(
                "INVALID_ARGUMENT",
                "Capture bounds are invalid",
                false,
            ));
        }
        let end = offset.saturating_add(maximum).min(bytes.len());
        Ok(
            json!({"data":STANDARD.encode(&bytes[offset..end]),"offset":offset,"nextOffset":end,"totalBytes":bytes.len(),"eof":end==bytes.len()}),
        )
    }
}

/// Read an optional native metadata attribute while preserving original provider failure status.
///
/// Args:
///     element (AXRef): Browser-owned native accessibility element.
///     name (&str): Fixed native attribute name.
/// Returns:
///     Result<Option<Owned>, BackendError>: Complete owned native value or an explicitly absent attribute.
fn metadata_attribute(element: AXRef, name: &str) -> Result<Option<Owned>, BackendError> {
    let key = cf_string(name)?;
    let mut value = ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut value) };
    // Provider timeout and malformed successful output terminate the entire private read.
    if mac_optional_attribute_status(status, !value.is_null())? {
        return Ok(Some(Owned(value)));
    }
    Ok(None)
}

/// Read private native browser chrome and retain source objects around public observation.
///
/// Args:
///     element (AXRef): Geometry-matched AX window owned by the bound browser.
///     mapping (Transform): Verified native physical coordinate transform.
///     pid (i32): Trusted browser application PID.
///     started (Instant): Shared observation deadline.
/// Returns:
///     Result<(Value, HashMap<String, Owned>), BackendError>: Internal metadata and retained identity objects.
fn read_url_metadata(
    element: AXRef,
    mapping: Transform,
    pid: i32,
    started: Instant,
) -> Result<(Value, HashMap<String, Owned>), BackendError> {
    let mut count = 0;
    let mut seen = HashSet::new();
    let mut retained = HashMap::new();
    let node = read_url_node(
        element,
        mapping,
        pid,
        0,
        false,
        &mut count,
        &mut seen,
        &mut retained,
        started,
    )?;
    Ok((node, retained))
}

/// Read native URL metadata while excluding page descendants at each document boundary.
///
/// Args:
///     element (AXRef): Borrowed native accessibility object.
///     mapping (Transform): Verified physical coordinate transform.
///     pid (i32): Bound browser application PID.
///     depth (usize): Private traversal depth.
///     toolbar (bool): Whether native browser toolbar ancestry is established.
///     count (&mut usize): Private node count.
///     seen (&mut HashSet<usize>): Visited native object hashes.
///     retained (&mut HashMap<String, Owned>): Retained native identity references.
///     started (Instant): Shared observation deadline.
/// Returns:
///     Result<Value, BackendError>: Internal browser-chrome and top-document metadata.
#[allow(clippy::too_many_arguments)]
fn read_url_node(
    element: AXRef,
    mapping: Transform,
    pid: i32,
    depth: usize,
    toolbar: bool,
    count: &mut usize,
    seen: &mut HashSet<usize>,
    retained: &mut HashMap<String, Owned>,
    started: Instant,
) -> Result<Value, BackendError> {
    // Require a live native object before computing its identity or issuing an AX request.
    if element.is_null() {
        return Err(native_error(()));
    }
    let hash = unsafe { CFHash(element) };
    // Bound private observation and reject repeated native identities before another remote call.
    if depth > 32
        || *count >= 4096
        || started.elapsed() > Duration::from_secs(8)
        || !seen.insert(hash)
    {
        return Err(BackendError::new(
            "TIMEOUT",
            "Native URL observation limit reached",
            true,
        ));
    }
    *count += 1;
    let mut owner = 0;
    // Keep private metadata within the independently bound browser accessibility provider.
    if unsafe { AXUIElementGetPid(element, &mut owner) } != 0 || owner != pid {
        return Err(BackendError::new(
            "TARGET_STALE",
            "Native accessibility provider ownership changed",
            true,
        ));
    }
    unsafe { AXUIElementSetMessagingTimeout(element, 1.0) };
    let role = text(attribute(element, "AXRole")?.0);
    // Require an original native role before establishing a document or chrome boundary.
    if role.is_empty() {
        return Err(native_error(()));
    }
    let identity = format!("ax-{hash}");
    retained.insert(identity.clone(), Owned(unsafe { CFRetain(element) }));
    let mut node = json!({"nativeId":identity,"role":role});
    // Retain document and window geometry independently from public privacy pruning.
    if let Some(bounds) = ax_bounds(element) {
        node["bounds"] = mapping.rectangle(bounds);
    }
    // Read the native root WebArea URL and stop before page controls or nested iframe roots.
    if document_boundary(UrlPlatform::Mac, &role) {
        if root_document(UrlPlatform::Mac, &role)
            && let Some(value) = metadata_attribute(element, "AXURL")?
        {
            // Native AXURL may be CFURL/NSURL; text converts it through CFURLGetString.
            if !unsafe {
                CFGetTypeID(value.0) == CFURLGetTypeID()
                    || CFGetTypeID(value.0) == CFStringGetTypeID()
            } {
                return Err(native_error(()));
            }
            node["documentUrl"] = json!(text(value.0));
        }
        return Ok(node);
    }
    let toolbar = toolbar || chrome_toolbar(UrlPlatform::Mac, &role);
    // Restrict fallback text reads to native address-field roles within browser chrome.
    if toolbar && address_role(UrlPlatform::Mac, &role) {
        let mut name = metadata_attribute(element, "AXTitle")?
            .map(|value| text(value.0))
            .unwrap_or_default();
        if name.is_empty() {
            name = metadata_attribute(element, "AXDescription")?
                .map(|value| text(value.0))
                .unwrap_or_default();
        }
        let identifier = metadata_attribute(element, "AXIdentifier")?
            .map(|value| text(value.0))
            .unwrap_or_default();
        node["name"] = json!(name);
        node["identifier"] = json!(identifier);
        // Read text only for a native omnibox marker outside document content.
        if identifier == "omnibox" || name == "Address and search bar" {
            if let Some(focused) = metadata_attribute(element, "AXFocused")?
                && unsafe { CFGetTypeID(focused.0) == CFBooleanGetTypeID() }
            {
                node["focused"] = json!(unsafe { CFBooleanGetValue(focused.0) });
            }
            if let Some(value) = metadata_attribute(element, "AXValue")? {
                node["value"] = json!(text(value.0));
            }
        }
    }
    // Inspect native chrome children while retaining the document-boundary exclusion.
    if let Some(children) = metadata_attribute(element, "AXChildren")? {
        // A successful children response must be an array before tree completeness is established.
        if !unsafe { CFGetTypeID(children.0) == CFArrayGetTypeID() } {
            return Err(native_error(()));
        }
        let mut output = Vec::new();
        for index in 0..unsafe { CFArrayGetCount(children.0) } {
            let child = unsafe { CFArrayGetValueAtIndex(children.0, index) };
            output.push(read_url_node(
                child,
                mapping,
                pid,
                depth + 1,
                toolbar,
                count,
                seen,
                retained,
                started,
            )?);
        }
        node["children"] = json!(output);
    }
    Ok(node)
}

/// Read a bounded native AX subtree while suppressing protected values and descendants.
///
/// Args:
///     element (AXRef): Current native accessible element.
///     mapping (Transform): Verified Retina coordinate transform.
///     depth (usize): Current traversal depth.
///     count (&mut usize): Shared node quota counter.
///     seen (&mut HashSet<usize>): Visited native element identities.
///     started (Instant): Overall observation deadline.
///     patterns (&[String]): Trusted literal sensitive label patterns.
/// Returns:
///     Result<Value, BackendError>: Redacted public AX node.
#[allow(clippy::too_many_arguments)]
fn read_node(
    element: AXRef,
    mapping: Transform,
    depth: usize,
    count: &mut usize,
    seen: &mut HashSet<usize>,
    started: Instant,
    patterns: &[String],
) -> Result<Value, BackendError> {
    // Bound AX depth, node count, observation time, and repeated native element identities.
    if depth > 32
        || *count >= 4096
        || started.elapsed() > Duration::from_secs(8)
        || !seen.insert(unsafe { CFHash(element) })
    {
        return Err(BackendError::new(
            "TIMEOUT",
            "Accessibility observation limit reached",
            true,
        ));
    }
    *count += 1;
    unsafe { AXUIElementSetMessagingTimeout(element, 1.0) };
    let role = attribute(element, "AXRole")
        .map(|value| text(value.0))
        .unwrap_or_else(|_| "unknown".to_owned());
    let subrole = attribute(element, "AXSubrole")
        .map(|value| text(value.0))
        .unwrap_or_default();
    let name = attribute(element, "AXTitle")
        .or_else(|_| attribute(element, "AXDescription"))
        .map(|value| text(value.0))
        .unwrap_or_default();
    let protected = subrole == "AXSecureTextField" || sensitive(&name, &role, patterns);
    let bounds = ax_bounds(element);
    let mut states = Vec::new();
    // Read the enabled, focused, and selected flags through native AX attributes.
    for (attribute_name, state) in [
        ("AXEnabled", "enabled"),
        ("AXFocused", "focused"),
        ("AXSelected", "selected"),
    ] {
        // Add an AX state only when its native Boolean attribute is true.
        if attribute(element, attribute_name).is_ok_and(|value| unsafe {
            CFGetTypeID(value.0) == CFBooleanGetTypeID() && CFBooleanGetValue(value.0)
        }) {
            states.push(state);
        }
    }
    let mut node = json!({"nodeId":format!("mac-{}",*count),"role":role,"name":if protected{"[protected]"}else{&name},"states":states});
    // Attach physical bounds when the native AX element exposes valid geometry.
    if let Some(bounds) = bounds {
        node["bounds"] = mapping.rectangle(bounds);
    }
    // Password values and descendants are removed before entering the local IPC encoder.
    if protected {
        node["states"]
            .as_array_mut()
            .unwrap()
            .push(json!("protected"));
        return Ok(node);
    }
    // Read the ordinary AX value only after protected elements have been filtered.
    if let Ok(value) = attribute(element, "AXValue") {
        let value = text(value.0);
        // Expose an AX value only when its native string conversion is nonempty.
        if !value.is_empty() {
            node["value"] = json!(value);
        }
    }
    // Traverse child elements only when AXChildren returns a native array.
    if let Ok(children) = attribute(element, "AXChildren")
        && unsafe { CFGetTypeID(children.0) == CFArrayGetTypeID() }
    {
        let mut output = Vec::new();
        // Read AX children within the remaining observation node budget.
        for index in 0..unsafe { CFArrayGetCount(children.0) }.min((4096 - *count) as isize) {
            let child = unsafe { CFArrayGetValueAtIndex(children.0, index) };
            output.push(read_node(
                child,
                mapping,
                depth + 1,
                count,
                seen,
                started,
                patterns,
            )?);
        }
        node["children"] = json!(output);
    }
    Ok(node)
}

/// Identify protected native accessible labels.
///
/// Args:
///     value (&str): Accessible label.
///     role (&str): Original native accessibility role.
///     patterns (&[String]): Trusted additional literal sensitive labels.
/// Returns:
///     bool: Whether credential or payment masking is required.
fn sensitive(value: &str, role: &str, patterns: &[String]) -> bool {
    let value = value.to_lowercase();
    [
        "password",
        "passcode",
        "credit card",
        "card number",
        "security code",
        "cvc",
        "cvv",
        "one-time",
    ]
    .iter()
    .any(|pattern| value.contains(pattern))
        || patterns.iter().any(|pattern| value.contains(pattern))
        || (matches!(
            role,
            "AXTextField"
                | "AXTextArea"
                | "AXComboBox"
                | "AXPopUpButton"
                | "AXIncrementor"
                | "AXCheckBox"
                | "AXRadioButton"
                | "AXSwitch"
                | "AXStaticText"
                | "AXLabel"
        ) && value
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .any(|word| word.eq_ignore_ascii_case("card")))
}

/// Read bounded masking labels supplied by the trusted runtime parent.
///
/// Args:
///     params (&Value): Internal native observation or capture parameters.
/// Returns:
///     Vec<String>: Case-normalized labels used before IPC encoding.
fn sensitive_patterns(params: &Value) -> Vec<String> {
    params
        .get("sensitivePatterns")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .take(64)
                .map(|value| value.chars().take(256).collect::<String>().to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// Validate an input point against native front-to-back window stacking.
///
/// Args:
///     bound (&WindowInfo): Independently bound browser window.
///     point (Point): Quartz logical input point.
/// Returns:
///     Result<(), BackendError>: Unoccluded browser ownership confirmation.
fn hit_test(bound: &WindowInfo, point: Point) -> Result<(), BackendError> {
    // Inspect visible windows from front to back to resolve pointer occlusion.
    for window in windows()? {
        let rect = window.bounds;
        // Find the first visible native rectangle containing the requested pointer location.
        if point.x >= rect.origin.x
            && point.y >= rect.origin.y
            && point.x < rect.origin.x + rect.size.width
            && point.y < rect.origin.y + rect.size.height
        {
            // Accept the hit only when its native window ID and PID match the binding.
            if window.id == bound.id && window.pid == bound.pid {
                return Ok(());
            }
            // Other visible windows, including transient sheets, require a separately verified binding.
            return Err(BackendError::new(
                "TARGET_OCCLUDED",
                "Input point belongs to another native window",
                true,
            ));
        }
    }
    Err(BackendError::new(
        "TARGET_NOT_FOUND",
        "Input point lies outside the bound browser",
        false,
    ))
}

/// Post one retained Quartz event through the HID event tap.
///
/// Args:
///     event (Owned): Retained native event object.
/// Returns:
///     Result<(), BackendError>: Event dispatch completion.
fn post(event: Owned) -> Result<(), BackendError> {
    // Require successful native event allocation before tagging and posting the event.
    if event.0.is_null() {
        return Err(native_error(()));
    }
    // Mark agent-owned native events so the read-only tap counts only external input.
    unsafe {
        CGEventSetIntegerValueField(event.0, 42, event_marker());
        CGEventPost(0, event.0)
    };
    Ok(())
}

/// Create a pointer event with the actual click-count field.
///
/// Args:
///     kind (u32): Quartz mouse event type.
///     point (Point): Quartz logical pointer location.
///     button (u32): Native mouse button.
///     count (i64): Native multi-click count.
/// Returns:
///     Result<(), BackendError>: Native pointer event dispatch.
fn mouse(kind: u32, point: Point, button: u32, count: i64) -> Result<(), BackendError> {
    let event = Owned(unsafe { CGEventCreateMouseEvent(ptr::null(), kind, point, button) });
    // Reject a missing Quartz mouse event before setting click metadata.
    if event.0.is_null() {
        return Err(native_error(()));
    }
    // Attach a click count to button events used for single or double clicks.
    if count > 0 {
        unsafe { CGEventSetIntegerValueField(event.0, 1, count) };
    }
    post(event)
}

/// Post a paired physical or Unicode keyboard event with exact modifier flags.
///
/// Args:
///     code (u16): Native keyboard virtual key.
///     flags (u64): Quartz modifier flags.
///     unicode (Option<&[u16]>): Optional UTF-16 character submission.
/// Returns:
///     Result<(), BackendError>: Balanced native keyboard dispatch.
fn key_pair(code: u16, flags: u64, unicode: Option<&[u16]>) -> Result<(), BackendError> {
    let down = Owned(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, true) });
    let up = Owned(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, false) });
    // Construct both objects before any input reaches the desktop.
    if down.0.is_null() || up.0.is_null() {
        return Err(native_error(()));
    }
    unsafe {
        CGEventSetFlags(down.0, flags);
        CGEventSetFlags(up.0, flags);
    }
    // Attach the same UTF-16 text payload to both native keyboard transitions.
    if let Some(units) = unicode {
        unsafe {
            CGEventKeyboardSetUnicodeString(down.0, units.len(), units.as_ptr());
            CGEventKeyboardSetUnicodeString(up.0, units.len(), units.as_ptr());
        }
    }
    post(down)?;
    post(up)
}

/// Resolve named physical keys and macOS modifier flags.
///
/// Args:
///     chord (&str): Named key and modifier chord.
/// Returns:
///     Result<(u16, u64), BackendError>: Native virtual key and modifier mask.
fn key_chord(chord: &str) -> Result<(u16, u64), BackendError> {
    let tokens: Vec<&str> = chord.split('+').collect();
    let mut flags = 0;
    // Convert the named chord modifiers into the corresponding Quartz event flags.
    for token in &tokens[..tokens.len().saturating_sub(1)] {
        flags |= match *token {
            "Shift" => 1 << 17,
            "Control" => 1 << 18,
            "Alt" => 1 << 19,
            "Meta" | "Command" => 1 << 20,
            _ => {
                return Err(BackendError::new(
                    "INVALID_ARGUMENT",
                    "Key modifier is invalid",
                    false,
                ));
            }
        };
    }
    let code = match tokens.last().copied().unwrap_or("") {
        "Enter" => 36,
        "Tab" => 48,
        "Space" => 49,
        "Backspace" => 51,
        "Escape" => 53,
        "Delete" => 117,
        "Home" => 115,
        "End" => 119,
        "PageUp" => 116,
        "PageDown" => 121,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "ArrowDown" => 125,
        "ArrowUp" => 126,
        "KeyA" => 0,
        "KeyS" => 1,
        "KeyD" => 2,
        "KeyF" => 3,
        "KeyH" => 4,
        "KeyG" => 5,
        "KeyZ" => 6,
        "KeyX" => 7,
        "KeyC" => 8,
        "KeyV" => 9,
        "KeyB" => 11,
        "KeyQ" => 12,
        "KeyW" => 13,
        "KeyE" => 14,
        "KeyR" => 15,
        "KeyY" => 16,
        "KeyT" => 17,
        "KeyO" => 31,
        "KeyU" => 32,
        "KeyI" => 34,
        "KeyP" => 35,
        "KeyL" => 37,
        "KeyJ" => 38,
        "KeyK" => 40,
        "KeyN" => 45,
        "KeyM" => 46,
        value if value.chars().count() == 1 => {
            let character = value.chars().next().ok_or_else(|| native_error(()))?;
            let (code, shift) = layout_key(character)?;
            // Add Shift when the active-layout lookup requires its shifted key output.
            if shift {
                flags |= 1 << 17;
            }
            code
        }
        _ => {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Named physical key is unavailable; use Key-prefixed physical letter codes",
                false,
            ));
        }
    };
    Ok((code, flags))
}

/// Resolve a character from the current macOS input source without changing layouts.
///
/// Args:
///     character (char): Character represented by a public key token.
/// Returns:
///     Result<(u16, bool), BackendError>: Native physical keycode and Shift requirement.
fn layout_key(character: char) -> Result<(u16, bool), BackendError> {
    let source = Owned(unsafe { TISCopyCurrentKeyboardLayoutInputSource() });
    // Require a selected native keyboard input source before translating a character.
    if source.0.is_null() {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Active keyboard layout is unavailable",
            false,
        ));
    }
    let data = unsafe { TISGetInputSourceProperty(source.0, kTISPropertyUnicodeKeyLayoutData) };
    // Require physical keyboard layout data for the selected input source.
    if data.is_null() {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Active input source has no physical keyboard layout",
            false,
        ));
    }
    let layout = unsafe { CFDataGetBytePtr(data) };
    // Reject an absent native Unicode keyboard layout byte pointer.
    if layout.is_null() {
        return Err(native_error(()));
    }
    let mut expected = [0_u16; 2];
    let expected = character.encode_utf16(&mut expected);
    // Compare each key's current unshifted and Shift output with the requested character.
    for shift in [false, true] {
        // Compare every supported physical key with the requested Unicode character.
        for code in 0..128_u16 {
            let mut state = 0;
            let mut length = 0;
            let mut output = [0_u16; 8];
            let result = unsafe {
                UCKeyTranslate(
                    layout.cast(),
                    code,
                    0,
                    // Select the Shift modifier state used by the native key translation call.
                    if shift { 2 } else { 0 },
                    u32::from(LMGetKbdType()),
                    1,
                    &mut state,
                    8,
                    &mut length,
                    output.as_mut_ptr(),
                )
            };
            // Accept only a successful layout translation whose complete UTF-16 output matches.
            if result == 0
                && length as usize == expected.len()
                && &output[..length as usize] == expected
            {
                return Ok((code, shift));
            }
        }
    }
    Err(BackendError::new(
        "UNSUPPORTED_CAPABILITY",
        "Character is absent from the active physical keyboard layout",
        false,
    ))
}

/// Read a Chromium application bundle's declared version through Core Foundation.
///
/// Args:
///     params (&Value): Trusted executable path supplied by the runtime launcher.
/// Returns:
///     Result<Value, BackendError>: Native application version metadata.
fn browser_version(params: &Value) -> Result<Value, BackendError> {
    let executable = Path::new(string(params, "executable")?);
    let bundle = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|value| value == "app"))
        .ok_or_else(|| {
            BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Browser application bundle is unavailable",
                false,
            )
        })?;
    let bytes = bundle.as_os_str().as_bytes();
    let url = Owned(unsafe {
        CFURLCreateFromFileSystemRepresentation(
            ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
            true,
        )
    });
    // Require a native file URL before opening the browser application bundle.
    if url.0.is_null() {
        return Err(native_error(()));
    }
    let application = Owned(unsafe { CFBundleCreate(ptr::null(), url.0) });
    // Require successful bundle construction before reading its version property.
    if application.0.is_null() {
        return Err(native_error(()));
    }
    let key = cf_string("CFBundleShortVersionString")?;
    let version = text(unsafe { CFBundleGetValueForInfoDictionaryKey(application.0, key.0) });
    // Validate a nonempty numeric dotted application version before reporting metadata.
    if version.is_empty()
        || !version
            .bytes()
            .all(|value| value.is_ascii_digit() || value == b'.')
    {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Browser bundle version metadata is unavailable",
            false,
        ));
    }
    Ok(json!({"version":version}))
}

/// Mask protected physical rectangles before PNG encoding or local IPC transfer.
///
/// Args:
///     pixels (&mut [u8]): Owned RGBA image data.
///     width (usize): Capture width in physical pixels.
///     height (usize): Capture height in physical pixels.
///     origin (Point): Bound window's physical capture origin.
///     node (&Value): Redacted accessibility tree with protection geometry.
/// Returns:
///     (): Completion of in-memory masking.
fn mask_rectangles(pixels: &mut [u8], width: usize, height: usize, origin: Point, node: &Value) {
    // Convert protected AX bounds into a clamped capture-local masking rectangle.
    if node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|state| state == "protected"))
        && let Some(bounds) = node.get("bounds")
    {
        let left = (bounds["x"].as_f64().unwrap_or(0.0) - origin.x)
            .floor()
            .clamp(0.0, width as f64) as usize;
        let top = (bounds["y"].as_f64().unwrap_or(0.0) - origin.y)
            .floor()
            .clamp(0.0, height as f64) as usize;
        let right = (bounds["x"].as_f64().unwrap_or(0.0) + bounds["width"].as_f64().unwrap_or(0.0)
            - origin.x)
            .ceil()
            .clamp(0.0, width as f64) as usize;
        let bottom = (bounds["y"].as_f64().unwrap_or(0.0)
            + bounds["height"].as_f64().unwrap_or(0.0)
            - origin.y)
            .ceil()
            .clamp(0.0, height as f64) as usize;
        // Visit each capture row intersecting the protected native rectangle.
        for y in top..bottom {
            // Replace each protected capture pixel with opaque black before PNG encoding.
            for x in left..right {
                pixels[(y * width + x) * 4..(y * width + x) * 4 + 4]
                    .copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
    // Continue masking through an accessible node that contains child elements.
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        // Apply protected-region masking recursively to each child AX element.
        for child in children {
            mask_rectangles(pixels, width, height, origin, child);
        }
    }
}

/// Require native geometry for every protected region before capture transfer.
///
/// Args:
///     node (&Value): Redacted accessibility tree.
/// Returns:
///     Result<(), BackendError>: Complete sensitive-region geometry validation.
fn require_mask_geometry(node: &Value) -> Result<(), BackendError> {
    // Keep pixel data local when protected elements have no verifiable capture rectangle.
    if node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|state| state == "protected"))
        && node.get("bounds").is_none()
    {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Protected capture geometry is unavailable",
            false,
        ));
    }
    // Inspect child elements when validating protected-region masking geometry.
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        // Require masking geometry for every protected descendant before capture transfer.
        for child in children {
            require_mask_geometry(child)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify Retina transforms with a negative secondary-display origin.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful round-trip coordinate assertions.
    #[test]
    fn retina_negative_origin() {
        let mapping = Transform {
            origin: Point { x: -1920.0, y: 0.0 },
            scale: 2.0,
        };
        let logical = Point {
            x: -1800.0,
            y: 100.0,
        };
        let physical = mapping.physical(logical);
        assert_eq!(physical.x, -1680.0);
        assert_eq!(physical.y, 200.0);
        assert_eq!(mapping.logical(physical).x, logical.x);
    }

    /// Verify fractional native protection bounds mask every touched pixel.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful sensitive-pixel boundary assertions.
    #[test]
    fn fractional_pixel_privacy() {
        let mut pixels = vec![255; 12];
        mask_rectangles(
            &mut pixels,
            3,
            1,
            Point { x: 0.0, y: 0.0 },
            &json!({"states":["protected"],"bounds":{"x":0.5,"y":0,"width":1,"height":1}}),
        );
        assert_eq!(&pixels[..8], &[0, 0, 0, 255, 0, 0, 0, 255]);
        assert_eq!(&pixels[8..], &[255, 255, 255, 255]);
    }

    /// Verify Card hints apply to editable controls and native labels with exact word boundaries.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful synthetic role, token-boundary, and custom-pattern assertions.
    #[test]
    fn card_label_privacy_scope() {
        // Classify field and label hints without expanding the default document-title scope.
        for value in ["Card", "card", "CARD", "Payment Card", "Card / expiry"] {
            assert!(sensitive(value, "AXTextField", &[]));
            assert!(sensitive(value, "AXStaticText", &[]));
        }
        for value in ["Cardboard", "Cardiology", "Discard", "card2", "card_name"] {
            assert!(!sensitive(value, "AXTextField", &[]));
        }
        for role in ["AXWindow", "AXWebArea", "AXGroup", "AXButton", "AXLink"] {
            assert!(!sensitive("Payment Card", role, &[]));
        }
        assert!(sensitive(
            "Special Token",
            "AXWebArea",
            &["special token".to_owned()]
        ));
    }
}
