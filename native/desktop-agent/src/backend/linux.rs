// -*- coding: utf-8 -*-
/*
linux.rs
Linux desktop backend
=====================

Use AT-SPI observation and verified X11/XTest input while reporting the
authorization and window-binding requirements of Wayland sessions.
*/
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::fs::{DirBuilder, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xinput;
use x11rb::protocol::xkb;
use x11rb::protocol::xproto::{self, ConnectionExt, ImageFormat, MapState, Window};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use zbus::blocking::{Connection as BusConnection, Proxy};
use zbus::zvariant::OwnedObjectPath;

use super::BackendError;
use super::url_authority::{
    UrlPlatform, address_role, chrome_toolbar, consistent_browser_url, document_boundary,
    document_geometry, root_document, trusted_browser_url, unique_bound_window_index,
    unique_window_index,
};

#[link(name = "c")]
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
        let metadata = fs::symlink_metadata(&directory).map_err(|_| {
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
            .custom_flags(0x20000)
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

const MAX_NODES: usize = 4096;
const MAX_DEPTH: usize = 32;
const MAX_CAPTURE_BYTES: usize = 32 * 1024 * 1024;

/// Bound X11 client identity and independently owned capture bytes.
struct Binding {
    pid: u32,
    window: Window,
    capture: Option<(String, Vec<u8>)>,
    cancellation: Arc<AtomicU64>,
}

static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
static HUMAN_GENERATION: AtomicU64 = AtomicU64::new(0);
static MONITOR_AVAILABLE: AtomicBool = AtomicBool::new(false);
static MONITOR_STARTED: OnceLock<bool> = OnceLock::new();

/// Start an XInput2 observer that distinguishes physical devices from XTest sources.
///
/// Args:
///     None.
/// Returns:
///     bool: Whether external-input interruption monitoring is active.
fn start_monitor() -> bool {
    *MONITOR_STARTED.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let setup = (|| {
                let (connection, screen) = x11rb::connect(None).map_err(unavailable)?;
                xinput::xi_query_version(&connection, 2, 0)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                let devices = xinput::xi_query_device(&connection, 0_u16)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                let synthetic: HashSet<u16> = devices
                    .infos
                    .iter()
                    .filter(|device| {
                        device.enabled && String::from_utf8_lossy(&device.name).contains("XTEST")
                    })
                    .map(|device| device.deviceid)
                    .collect();
                // Require identified synthetic keyboard and pointer sources before classifying human input.
                if synthetic.len() < 2 {
                    return Err(unavailable(()));
                }
                // Hierarchy events belong to all devices; raw input is selected on master devices.
                let masks = [
                    xinput::EventMask {
                        deviceid: 1,
                        mask: vec![
                            xinput::XIEventMask::RAW_KEY_PRESS
                                | xinput::XIEventMask::RAW_KEY_RELEASE
                                | xinput::XIEventMask::RAW_BUTTON_PRESS
                                | xinput::XIEventMask::RAW_BUTTON_RELEASE
                                | xinput::XIEventMask::RAW_MOTION,
                        ],
                    },
                    xinput::EventMask {
                        deviceid: 0,
                        mask: vec![xinput::XIEventMask::HIERARCHY],
                    },
                ];
                xinput::xi_select_events(
                    &connection,
                    connection.setup().roots[screen].root,
                    &masks,
                )
                .map_err(unavailable)?
                .check()
                .map_err(unavailable)?;
                connection.flush().map_err(unavailable)?;
                Ok((connection, synthetic))
            })();
            let Ok((connection, synthetic)) = setup else {
                let _ = sender.send(false);
                return;
            };
            MONITOR_AVAILABLE.store(true, Ordering::SeqCst);
            let _ = sender.send(true);
            // Retain event categories and source identities only; key values and pointer locations are excluded.
            while let Ok(event) = connection.wait_for_event() {
                let source = match event {
                    Event::XinputRawKeyPress(value) => Some(value.sourceid),
                    Event::XinputRawKeyRelease(value) => Some(value.sourceid),
                    Event::XinputRawButtonPress(value) => Some(value.sourceid),
                    Event::XinputRawButtonRelease(value) => Some(value.sourceid),
                    Event::XinputRawMotion(value) => Some(value.sourceid),
                    Event::XinputHierarchy(_) => {
                        break;
                    }
                    _ => None,
                };
                // Count physical source devices while excluding the identified XTest virtual devices.
                if source.is_some_and(|value| !synthetic.contains(&value)) {
                    HUMAN_GENERATION.fetch_add(1, Ordering::SeqCst);
                }
            }
            MONITOR_AVAILABLE.store(false, Ordering::SeqCst);
        });
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or(false)
    }) && MONITOR_AVAILABLE.load(Ordering::SeqCst)
}

/// Interrupt a bound input operation from the authenticated IPC reader.
///
/// Args:
///     session_id (&str): Desktop session identifier.
/// Returns:
///     bool: Whether the session had a registered interruption generation.
pub fn interrupt(session_id: &str) -> bool {
    // Shared generations preserve signals without resetting an active cancellation flag.
    if let Some(values) = CANCELLATIONS.get().and_then(|lock| lock.lock().ok())
        && let Some(generation) = values.get(session_id)
    {
        generation.fetch_add(1, Ordering::SeqCst);
        return true;
    }
    false
}

/// Linux desktop resources scoped to the authenticated agent lifetime.
pub struct DesktopBackend {
    display: Option<(RustConnection, usize)>,
    bus: Option<BusConnection>,
    accessibility: Option<BusConnection>,
    wayland: bool,
    bindings: HashMap<String, Binding>,
    sequence: u64,
}

/// Classify an operating-system API failure without returning service details.
///
/// Args:
///     _error (E): Native service error excluded from diagnostics.
/// Returns:
///     BackendError: Stable unavailable-service classification.
fn unavailable<E>(_error: E) -> BackendError {
    BackendError::new(
        "INPUT_BACKEND_UNAVAILABLE",
        "Desktop service is unavailable",
        true,
    )
}

/// Read a required nonempty string from an IPC parameter object.
///
/// Args:
///     params (&Value): Validated outer IPC parameters.
///     name (&str): Required parameter name.
/// Returns:
///     Result<&str, BackendError>: Parameter text or a validation error.
fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str, BackendError> {
    // Reject missing fields before reaching any native API.
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            BackendError::new("INVALID_ARGUMENT", "A string parameter is required", false)
        })
}

/// Read a bounded signed screen coordinate or input delta.
///
/// Args:
///     params (&Value): Input parameters.
///     name (&str): Coordinate field.
/// Returns:
///     Result<i32, BackendError>: Bounded integral coordinate.
fn integer(params: &Value, name: &str) -> Result<i32, BackendError> {
    params
        .get(name)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| {
            BackendError::new(
                "INVALID_ARGUMENT",
                "An integral input coordinate is required",
                false,
            )
        })
}

/// Establish an AT-SPI bus with bounded D-Bus method deadlines.
///
/// Args:
///     session (&BusConnection): Current user's session bus.
/// Returns:
///     zbus::Result<BusConnection>: AT-SPI bus connection.
fn accessibility_bus(session: &BusConnection) -> zbus::Result<BusConnection> {
    let bus = Proxy::new(session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")?;
    let address: String = bus.call("GetAddress", &())?;
    zbus::blocking::connection::Builder::address(address.as_str())?
        .method_timeout(Duration::from_secs(2))
        .build()
}

impl DesktopBackend {
    /// Detect the desktop protocol and open explicitly selected local services.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Result<Self, BackendError>: Backend capable of reporting unavailable services.
    pub fn new() -> Result<Self, BackendError> {
        let wayland = env::var_os("WAYLAND_DISPLAY").is_some()
            || env::var("XDG_SESSION_TYPE").is_ok_and(|value| value == "wayland");
        // A Wayland seat retains its protocol classification even when XWayland exists.
        let display = if wayland {
            None
        } else {
            x11rb::connect(None).ok()
        };
        // Open a separate read-only observer only for an explicitly selected X11 seat.
        if display.is_some() {
            start_monitor();
        }
        let bus = zbus::blocking::connection::Builder::session()
            .ok()
            .and_then(|builder| builder.method_timeout(Duration::from_secs(2)).build().ok());
        let accessibility = bus.as_ref().and_then(|value| accessibility_bus(value).ok());
        Ok(Self {
            display,
            bus,
            accessibility,
            wayland,
            bindings: HashMap::new(),
            sequence: 0,
        })
    }

    /// Dispatch authenticated desktop operations with protocol-specific capabilities.
    ///
    /// Args:
    ///     method (&str): Shared desktop IPC method.
    ///     params (&Value): Method parameter object.
    /// Returns:
    ///     Result<Value, BackendError>: Structured native result.
    pub fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, BackendError> {
        // Permit doctor on seats with absent display or permission services.
        match method {
            "desktop.doctor" => Ok(self.doctor()),
            "desktop.browserVersion" => browser_version(params),
            "desktop.listWindows" => self.windows(params),
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
            "desktop.cancel" => Ok(json!({"cancelled":interrupt(string(params,"sessionId")?)})),
            _ => Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Desktop method is unavailable",
                false,
            )),
        }
    }

    /// Report actual X11 extension and Portal service availability.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Value: Permission and desktop-protocol report.
    fn doctor(&self) -> Value {
        let xtest = self.display.as_ref().is_some_and(|(connection, _)| {
            connection
                .query_extension(b"XTEST")
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some_and(|reply| reply.present)
        });
        let wm = self.display.as_ref().is_some_and(|(connection, screen)| {
            property32(
                connection,
                connection.setup().roots[*screen].root,
                "_NET_SUPPORTING_WM_CHECK",
            )
            .is_ok_and(|values| !values.is_empty())
        });
        let mut portal_version = 0_u32;
        let mut devices = 0_u32;
        // Query capabilities without opening a session or presenting an authorization prompt.
        if let Some(connection) = &self.bus
            && let Ok(proxy) = Proxy::new(
                connection,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.RemoteDesktop",
            )
        {
            portal_version = proxy.get_property("version").unwrap_or(0);
            devices = proxy.get_property("AvailableDeviceTypes").unwrap_or(0);
        }
        json!({"platform":"linux","schemaVersion":1,
            "windowSystem":if self.wayland {"wayland"} else if self.display.is_some() {"x11"} else {"unavailable"},
            "xwaylandPresent":self.wayland && env::var_os("DISPLAY").is_some(),
            "accessibility":self.accessibility.is_some(),"screenCapture":!self.wayland && wm,
            "input":!self.wayland && xtest && wm&&MONITOR_AVAILABLE.load(Ordering::SeqCst),"atomicNavigate":false,"foregroundValidation":!self.wayland && wm,
            "userInputMonitoring":MONITOR_AVAILABLE.load(Ordering::SeqCst),
            "ime":false,"portal":{"version":portal_version,"availableDeviceTypes":devices,
                "authorization":"not-requested","sessionActive":false,
                "inputBackend":if portal_version>0 {"remote-desktop-notify-methods-declared"} else {"unavailable"},
                "eisMethodDeclared":portal_version>=2,"eisConnectionEstablished":false,
                "screenCastSessionActive":false,"inputGranted":false,"backend":"unidentified","windowBinding":false},
            "reason":if self.wayland {"PORTAL_WINDOW_BINDING_REQUIRED"} else if !wm {"EWMH_DESKTOP_REQUIRED"} else if !xtest {"XTEST_UNAVAILABLE"} else if !MONITOR_AVAILABLE.load(Ordering::SeqCst){"XINPUT2_MONITOR_REQUIRED"}else {"AVAILABLE"}})
    }

    /// Require an X11 connection and a real EWMH desktop window manager.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Result<(&RustConnection, usize), BackendError>: X11 connection and screen index.
    fn x11(&self) -> Result<(&RustConnection, usize), BackendError> {
        // Keep Wayland input blocked until an authorized stream has a verified browser binding.
        if self.wayland {
            return Err(BackendError::new(
                "INPUT_BACKEND_UNAVAILABLE",
                "Wayland requires an authorized Portal stream and verified browser window binding",
                false,
            ));
        }
        let (connection, screen) = self.display.as_ref().ok_or_else(|| unavailable(()))?;
        // A display-only virtual server cannot establish desktop foreground ownership.
        if property32(
            connection,
            connection.setup().roots[*screen].root,
            "_NET_SUPPORTING_WM_CHECK",
        )?
        .is_empty()
        {
            return Err(BackendError::new(
                "INPUT_BACKEND_UNAVAILABLE",
                "An EWMH desktop window manager is required",
                false,
            ));
        }
        Ok((connection, *screen))
    }

    /// Enumerate mapped EWMH clients and their operating-system process identities.
    ///
    /// Args:
    ///     params (&Value): Optional PID filter.
    /// Returns:
    ///     Result<Value, BackendError>: Owned browser candidates with physical bounds.
    fn windows(&self, params: &Value) -> Result<Value, BackendError> {
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[screen].root;
        let active = property32(connection, root, "_NET_ACTIVE_WINDOW")?
            .first()
            .copied();
        let filter = params.get("pid").and_then(Value::as_u64);
        let mut result = Vec::new();
        // Limit enumeration to the window manager's registered clients.
        let clients = property32(connection, root, "_NET_CLIENT_LIST")?;
        // A truncated native client list cannot establish unique browser window geometry.
        if clients.len() > 1024 {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Native client list exceeds its complete-observation quota",
                false,
            ));
        }
        for window in clients {
            let pid = property32(connection, window, "_NET_WM_PID")?
                .first()
                .copied()
                .unwrap_or(0);
            // Restrict unfiltered listings to Chromium browser executable names.
            if pid == 0
                || filter.is_some_and(|value| value != u64::from(pid))
                || !browser_process(pid)
            {
                continue;
            }
            let attrs = connection
                .get_window_attributes(window)
                .map_err(unavailable)?
                .reply()
                .map_err(unavailable)?;
            // Expose visible clients with a stable process association.
            if attrs.map_state != MapState::VIEWABLE {
                continue;
            }
            let bounds = window_bounds(connection, root, window)?;
            let title = property_text(connection, window, "_NET_WM_NAME").unwrap_or_default();
            result.push(
                json!({"windowId":window.to_string(),"pid":pid,"title":title,
                "bounds":bounds,"scale":1,"foreground":active==Some(window)}),
            );
        }
        Ok(json!(result))
    }

    /// Bind a trusted browser launch PID to an independently verified X11 client.
    ///
    /// Args:
    ///     params (&Value): Session identifier, PID, and decimal X11 window identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Binding acknowledgement.
    fn bind(&mut self, params: &Value) -> Result<Value, BackendError> {
        let session = string(params, "sessionId")?.to_owned();
        let pid = params
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| {
                BackendError::new(
                    "INVALID_ARGUMENT",
                    "A browser process identifier is required",
                    false,
                )
            })?;
        let window: Window = string(params, "windowId")?.parse().map_err(|_| {
            BackendError::new(
                "INVALID_ARGUMENT",
                "An X11 client identifier is required",
                false,
            )
        })?;
        let (connection, _) = self.x11()?;
        // Verify both native process metadata and the browser executable before ownership is recorded.
        if property32(connection, window, "_NET_WM_PID")?.first() != Some(&pid)
            || !browser_process(pid)
        {
            return Err(BackendError::new(
                "POLICY_DENIED",
                "Window ownership does not match the browser process",
                false,
            ));
        }
        // Establish complete unique native and accessibility geometry before recording ownership.
        let (_, screen) = self.x11()?;
        let bounds = window_bounds(connection, connection.setup().roots[screen].root, window)?;
        self.unique_native_geometry(pid, window, &bounds)?;
        let bus = self.accessibility.as_ref().ok_or_else(|| {
            BackendError::new(
                "PERMISSION_REQUIRED",
                "AT-SPI accessibility service is required",
                true,
            )
        })?;
        let application = application_for_pid(bus, pid)?;
        let metadata = read_url_metadata(bus, &application.0, &application.1, Instant::now())?;
        select_window(&metadata, &bounds).ok_or_else(|| {
            BackendError::new(
                "TARGET_STALE",
                "Native accessibility window geometry is absent or ambiguous",
                true,
            )
        })?;
        // Keep memory and shared desktop ownership bounded.
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
            .map_err(unavailable)?
            .insert(session.clone(), cancellation.clone());
        self.bindings.insert(
            session,
            Binding {
                pid,
                window,
                capture: None,
                cancellation,
            },
        );
        Ok(json!({"bound":true,"windowId":window.to_string(),"pid":pid}))
    }

    /// Retrieve a binding and revalidate the current window process identity.
    ///
    /// Args:
    ///     params (&Value): Session identifier.
    /// Returns:
    ///     Result<&Binding, BackendError>: Live, process-matched window binding.
    fn binding(&self, params: &Value) -> Result<&Binding, BackendError> {
        let binding = self
            .bindings
            .get(string(params, "sessionId")?)
            .ok_or_else(|| {
                BackendError::new("SESSION_NOT_FOUND", "Desktop session is absent", false)
            })?;
        let (connection, _) = self.x11()?;
        // Reject recycled window identifiers and browser process exit.
        if property32(connection, binding.window, "_NET_WM_PID")?.first() != Some(&binding.pid)
            || !browser_process(binding.pid)
        {
            return Err(BackendError::new(
                "BROWSER_DISCONNECTED",
                "Browser window ownership changed",
                false,
            ));
        }
        let (_, screen) = self.x11()?;
        let bounds = window_bounds(
            connection,
            connection.setup().roots[screen].root,
            binding.window,
        )?;
        self.unique_native_geometry(binding.pid, binding.window, &bounds)?;
        Ok(binding)
    }

    /// Require one complete native client rectangle for the bound process and window geometry.
    ///
    /// Args:
    ///     pid (u32): Trusted bound browser PID.
    ///     window (Window): Exact bound X11 client identifier.
    ///     bounds (&Value): Current bound X11 client rectangle.
    /// Returns:
    ///     Result<(), BackendError>: Unique native geometry or a closed window identity gate.
    fn unique_native_geometry(
        &self,
        pid: u32,
        window: Window,
        bounds: &Value,
    ) -> Result<(), BackendError> {
        let windows = self.windows(&json!({"pid":pid}))?;
        let matches: Vec<(String, Option<bool>)> = windows
            .as_array()
            .ok_or_else(|| unavailable(()))?
            .iter()
            .map(|candidate| {
                (
                    candidate["windowId"].as_str().unwrap_or("").to_owned(),
                    candidate
                        .get("bounds")
                        .map(|value| same_window_geometry(value, bounds)),
                )
            })
            .collect();
        unique_bound_window_index(&matches, &window.to_string())?;
        Ok(())
    }

    /// Request activation through the window manager and verify its final decision.
    ///
    /// Args:
    ///     params (&Value): Bound session identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Verified foreground acknowledgement.
    fn focus(&self, params: &Value) -> Result<Value, BackendError> {
        // Foreground changes share the cross-agent desktop input seat.
        let _lease = DesktopLease::acquire()?;
        let binding = self.binding(params)?;
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[screen].root;
        let message = xproto::ClientMessageEvent::new(
            32,
            binding.window,
            atom(connection, "_NET_ACTIVE_WINDOW")?,
            [1, x11rb::CURRENT_TIME, 0, 0, 0],
        );
        connection
            .send_event(
                false,
                root,
                xproto::EventMask::SUBSTRUCTURE_REDIRECT | xproto::EventMask::SUBSTRUCTURE_NOTIFY,
                message,
            )
            .map_err(unavailable)?
            .check()
            .map_err(unavailable)?;
        connection.flush().map_err(unavailable)?;
        let started = Instant::now();
        // Observe the EWMH foreground result; activation restrictions remain authoritative.
        while started.elapsed() < Duration::from_millis(750) {
            // Complete activation only after the EWMH foreground window matches the binding.
            if self.foreground(binding).is_ok() {
                return Ok(json!({"focused":true}));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(BackendError::new(
            "FOCUS_LOST",
            "Window manager did not activate the browser",
            true,
        ))
    }

    /// Require the browser to remain the active EWMH client.
    ///
    /// Args:
    ///     binding (&Binding): Independently verified browser binding.
    /// Returns:
    ///     Result<(), BackendError>: Foreground identity validation.
    fn foreground(&self, binding: &Binding) -> Result<(), BackendError> {
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[screen].root;
        let bounds = window_bounds(connection, root, binding.window)?;
        self.unique_native_geometry(binding.pid, binding.window, &bounds)?;
        // Foreground input always uses the client's current process association.
        if property32(connection, root, "_NET_ACTIVE_WINDOW")?.first() != Some(&binding.window)
            || property32(connection, binding.window, "_NET_WM_PID")?.first() != Some(&binding.pid)
        {
            return Err(BackendError::new(
                "FOCUS_LOST",
                "Browser is not the foreground client",
                true,
            ));
        }
        Ok(())
    }

    /// Observe a bounded, read-only AT-SPI tree of the bound browser window.
    ///
    /// Args:
    ///     params (&Value): Bound session identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Redacted accessibility observation and geometry.
    fn observe(&self, params: &Value) -> Result<Value, BackendError> {
        let binding = self.binding(params)?;
        let (connection, screen) = self.x11()?;
        let bounds = window_bounds(
            connection,
            connection.setup().roots[screen].root,
            binding.window,
        )?;
        let bus = self.accessibility.as_ref().ok_or_else(|| {
            BackendError::new(
                "PERMISSION_REQUIRED",
                "AT-SPI accessibility service is required",
                true,
            )
        })?;
        let application = application_for_pid(bus, binding.pid)?;
        let started = Instant::now();
        // Resolve browser origin through a private native walk before privacy filtering.
        let private_before = read_url_metadata(bus, &application.0, &application.1, started)?;
        let selected_before = select_window(&private_before, &bounds).ok_or_else(|| {
            BackendError::new(
                "TARGET_NOT_FOUND",
                "Native browser window metadata is absent",
                true,
            )
        })?;
        let before = trusted_browser_url(selected_before, UrlPlatform::Linux)?;
        let mut seen = HashSet::new();
        let mut count = 0;
        let patterns = sensitive_patterns(params);
        let root = read_node(
            bus,
            &application.0,
            &application.1,
            0,
            &mut count,
            &mut seen,
            started,
            &patterns,
        )?;
        // Select only the native window whose geometry matches the bound X11 client.
        let selected = select_window(&root, &bounds).ok_or_else(|| {
            BackendError::new(
                "TARGET_NOT_FOUND",
                "AT-SPI window geometry did not match the bound browser",
                true,
            )
        })?;
        let viewport =
            document_geometry(selected_before, UrlPlatform::Linux, &before).ok_or_else(|| {
                BackendError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "Browser viewport geometry is unavailable",
                    false,
                )
            })?;
        // Recheck native identity and origin after the public tree has been read.
        let private_after = read_url_metadata(bus, &application.0, &application.1, started)?;
        let selected_after = select_window(&private_after, &bounds).ok_or_else(|| {
            BackendError::new(
                "TARGET_STALE",
                "Native browser window metadata changed",
                true,
            )
        })?;
        let after = trusted_browser_url(selected_after, UrlPlatform::Linux)?;
        consistent_browser_url(&before, &after)?;
        // Preserve the selected document rectangle throughout the public observation.
        if document_geometry(selected_after, UrlPlatform::Linux, &after) != Some(viewport) {
            return Err(BackendError::new(
                "TARGET_STALE",
                "Native document geometry changed",
                true,
            ));
        }
        let current = self.binding(params)?;
        let current_bounds = window_bounds(
            connection,
            connection.setup().roots[screen].root,
            current.window,
        )?;
        // Preserve a consistent window rectangle throughout the bounded observation.
        if current_bounds != bounds {
            return Err(BackendError::new(
                "TARGET_STALE",
                "Browser window geometry changed",
                true,
            ));
        }
        let public_root = selected.clone();
        let url = before.url;
        Ok(
            json!({"windowId":binding.window.to_string(),"root":public_root,"url":url,
            "scale":{"dpr":1,"zoom":1},"geometry":{"windowOrigin":{"x":bounds["x"],"y":bounds["y"]},
                "viewportOrigin":{"x":viewport["x"],"y":viewport["y"]},"monitorScale":1,"viewportMetricsVerified":false}}),
        )
    }

    /// Dispatch XTest input after foreground and hit-test validation.
    ///
    /// Args:
    ///     params (&Value): Shared input request with screen-physical coordinates.
    /// Returns:
    ///     Result<Value, BackendError>: Actual operating-system input strategy.
    fn input(&self, params: &Value) -> Result<Value, BackendError> {
        // Serialize native input across independently launched runtime Agents.
        let _lease = DesktopLease::acquire()?;
        let binding = self.binding(params)?;
        let started = Instant::now();
        let timeout = Duration::from_millis(
            params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(15000)
                .clamp(1, 60000),
        );
        let generation = (
            binding.cancellation.load(Ordering::SeqCst),
            HUMAN_GENERATION.load(Ordering::SeqCst),
        );
        self.checkpoint(binding, generation, started, timeout)?;
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[screen].root;
        let kind = string(params, "kind")?;
        // Check native extension availability before admitting any input event.
        let available = connection
            .query_extension(b"XTEST")
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?
            .present;
        // Require the XTest extension before posting any native input event.
        if !available {
            return Err(unavailable(()));
        }
        // Route the requested input kind to pointer, scroll, named-key, or text submission.
        match kind {
            "move" | "click" | "doubleClick" | "drag" => {
                let x = integer(params, "x")?;
                let y = integer(params, "y")?;
                let endpoint = if kind == "drag" {
                    let end_x = integer(params, "endX")?;
                    let end_y = integer(params, "endY")?;
                    validate_point(connection, root, binding.window, end_x, end_y)?;
                    Some((end_x, end_y))
                } else {
                    None
                };
                validate_point(connection, root, binding.window, x, y)?;
                fake(connection, xproto::MOTION_NOTIFY_EVENT, 0, root, x, y)?;
                // Keep every button press paired with its release, including failure paths.
                if kind != "move" {
                    let button = match params
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left")
                    {
                        "left" => 1,
                        "middle" => 2,
                        "right" => 3,
                        _ => {
                            return Err(BackendError::new(
                                "INVALID_ARGUMENT",
                                "Mouse button is invalid",
                                false,
                            ));
                        }
                    };
                    let count = if kind == "doubleClick" { 2 } else { 1 };
                    // Pair each click press and release while checking cancellation and drag ownership.
                    for _ in 0..count {
                        self.checkpoint(binding, generation, started, timeout)?;
                        fake(connection, xproto::BUTTON_PRESS_EVENT, button, root, 0, 0)?;
                        let result = if let Some((end_x, end_y)) = endpoint {
                            validate_point(connection, root, binding.window, end_x, end_y)
                                .and_then(|()| {
                                    self.checkpoint(binding, generation, started, timeout)
                                })
                                .and_then(|()| {
                                    fake(
                                        connection,
                                        xproto::MOTION_NOTIFY_EVENT,
                                        0,
                                        root,
                                        end_x,
                                        end_y,
                                    )
                                })
                        } else {
                            Ok(())
                        };
                        let release =
                            fake(connection, xproto::BUTTON_RELEASE_EVENT, button, root, 0, 0);
                        result?;
                        release?;
                    }
                }
            }
            "scroll" => {
                let pointer = connection
                    .query_pointer(root)
                    .map_err(unavailable)?
                    .reply()
                    .map_err(unavailable)?;
                validate_point(
                    connection,
                    root,
                    binding.window,
                    i32::from(pointer.root_x),
                    i32::from(pointer.root_y),
                )?;
                // X11 wheel buttons provide discrete wheel steps with an explicit bounded conversion.
                for (delta, positive, negative) in [
                    (integer(params, "deltaY")?, 5, 4),
                    (integer(params, "deltaX")?, 7, 6),
                ] {
                    let steps = delta.unsigned_abs().div_ceil(120).min(100);
                    let button = if delta > 0 { positive } else { negative };
                    // Emit each bounded wheel step as a native button press and matching release.
                    for _ in 0..steps {
                        self.checkpoint(binding, generation, started, timeout)?;
                        fake(connection, xproto::BUTTON_PRESS_EVENT, button, root, 0, 0)?;
                        fake(connection, xproto::BUTTON_RELEASE_EVENT, button, root, 0, 0)?;
                    }
                }
            }
            "key" => {
                self.checkpoint(binding, generation, started, timeout)?;
                self.key(binding, string(params, "key")?)?;
            }
            "text" => {
                // Physical text entry uses only the active server keymap and reports unsupported characters.
                let strategy = params
                    .get("strategy")
                    .and_then(Value::as_str)
                    .unwrap_or("auto");
                // Require the available physical-keyboard text strategy for X11 submission.
                if !matches!(strategy, "auto" | "keyboard") {
                    return Err(BackendError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "X11 Unicode and IME text strategies require separate integration",
                        false,
                    ));
                }
                let text = string(params, "text")?;
                // Bound the text batch before resolving keyboard mappings or injecting characters.
                if text.chars().count() > 4096 {
                    return Err(BackendError::new(
                        "INVALID_ARGUMENT",
                        "Text input quota exceeded",
                        false,
                    ));
                }
                let mapping = keyboard_mapping(connection)?;
                let mut events = Vec::new();
                // Resolve the complete string before injecting to prevent partial unsupported input.
                for character in text.chars() {
                    let symbol = if character == '\n' {
                        0xff0d
                    } else if character == '\t' {
                        0xff09
                    } else if u32::from(character) <= 0xff {
                        u32::from(character)
                    } else {
                        0x01000000 | u32::from(character)
                    };
                    events.push(resolve_symbol(&mapping, symbol)?);
                }
                // Submit prevalidated key mappings with a fresh action checkpoint per character.
                for (code, shifted) in events {
                    self.checkpoint(binding, generation, started, timeout)?;
                    key_pair(connection, root, code, shifted, &mapping)?;
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
        connection.flush().map_err(unavailable)?;
        Ok(json!({"executed":true,"actualStrategy":"os-keyboard"}))
    }

    /// Validate cancellation generation, deadline, and foreground before an input batch.
    ///
    /// Args:
    ///     binding (&Binding): Bound browser and interruption generation.
    ///     generation ((u64, u64)): Cancellation and user-input generations at action start.
    ///     started (Instant): Action start time.
    ///     timeout (Duration): Action deadline.
    /// Returns:
    ///     Result<(), BackendError>: Admission to the next native input batch.
    fn checkpoint(
        &self,
        binding: &Binding,
        generation: (u64, u64),
        started: Instant,
        timeout: Duration,
    ) -> Result<(), BackendError> {
        // Keep the input lease until every accepted native event has its paired release.
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
        // Require active XInput2 user-input monitoring before continuing native input.
        if !MONITOR_AVAILABLE.load(Ordering::SeqCst) {
            return Err(BackendError::new(
                "INPUT_BACKEND_UNAVAILABLE",
                "XInput2 user-input monitoring is required; restart after device changes",
                true,
            ));
        }
        self.foreground(binding)
    }

    /// Resolve and dispatch a physical key chord through the active X11 keyboard map.
    ///
    /// Args:
    ///     binding (&Binding): Bound foreground browser.
    ///     chord (&str): Public key and modifier chord.
    /// Returns:
    ///     Result<(), BackendError>: Paired key dispatch completion.
    fn key(&self, binding: &Binding, chord: &str) -> Result<(), BackendError> {
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[screen].root;
        let mapping = keyboard_mapping(connection)?;
        let tokens: Vec<&str> = chord.split('+').collect();
        let mut modifiers = Vec::new();
        // Resolve supported modifier names before changing the seat's keyboard state.
        for token in &tokens[..tokens.len().saturating_sub(1)] {
            let symbol = match *token {
                "Control" => 0xffe3,
                "Shift" => 0xffe1,
                "Alt" => 0xffe9,
                "Meta" => 0xffeb,
                _ => {
                    return Err(BackendError::new(
                        "INVALID_ARGUMENT",
                        "Key modifier is invalid",
                        false,
                    ));
                }
            };
            modifiers.push(resolve_symbol(&mapping, symbol)?.0);
        }
        let symbol = key_symbol(tokens.last().copied().unwrap_or(""))?;
        let (key, shifted) = resolve_symbol(&mapping, symbol)?;
        self.foreground(binding)?;
        let mut pressed = Vec::new();
        // Release all accepted modifiers even if a subsequent event fails.
        let result = (|| {
            // Press the requested chord modifiers while recording each successfully inserted key.
            for modifier in &modifiers {
                fake(connection, xproto::KEY_PRESS_EVENT, *modifier, root, 0, 0)?;
                pressed.push(*modifier);
            }
            key_pair(
                connection,
                root,
                key,
                shifted && !tokens.contains(&"Shift"),
                &mapping,
            )
        })();
        // Release only recorded chord modifiers in reverse order after success or failure.
        for modifier in pressed.into_iter().rev() {
            let _ = fake(connection, xproto::KEY_RELEASE_EVENT, modifier, root, 0, 0);
        }
        result
    }

    /// Capture and redact visible browser pixels before storing transferable PNG bytes.
    ///
    /// Args:
    ///     params (&Value): Bound session identifier.
    /// Returns:
    ///     Result<Value, BackendError>: Opaque in-memory capture descriptor.
    fn capture(&mut self, params: &Value) -> Result<Value, BackendError> {
        let observation = self.observe(params)?;
        require_mask_geometry(&observation["root"])?;
        let binding = self.binding(params)?;
        self.foreground(binding)?;
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[screen].root;
        let bounds = window_bounds(connection, root, binding.window)?;
        let width = bounds["width"].as_u64().unwrap_or(0);
        let height = bounds["height"].as_u64().unwrap_or(0);
        // Bound capture allocation before issuing the native image request.
        if width == 0 || height == 0 || width * height > 16_777_216 {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Window capture dimensions exceed limits",
                false,
            ));
        }
        let image = connection
            .get_image(
                ImageFormat::Z_PIXMAP,
                binding.window,
                0,
                0,
                u16::try_from(width).map_err(unavailable)?,
                u16::try_from(height).map_err(unavailable)?,
                u32::MAX,
            )
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        let setup = connection.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == image.depth)
            .ok_or_else(|| {
                BackendError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "X11 pixel format is unsupported",
                    false,
                )
            })?;
        let visual = setup.roots[screen]
            .allowed_depths
            .iter()
            .flat_map(|depth| &depth.visuals)
            .find(|visual| visual.visual_id == image.visual)
            .ok_or_else(|| {
                BackendError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "X11 image visual is unavailable",
                    false,
                )
            })?;
        let mut rgba = image_rgba(
            &image.data,
            width as usize,
            height as usize,
            format.bits_per_pixel,
            format.scanline_pad,
            setup.image_byte_order == xproto::ImageOrder::LSB_FIRST,
            [visual.red_mask, visual.green_mask, visual.blue_mask],
        )?;
        let after = self.observe(params)?;
        require_mask_geometry(&after["root"])?;
        // Discard pixels if navigation changed the authorized origin during capture.
        if after["url"] != observation["url"] {
            return Err(BackendError::new(
                "TARGET_STALE",
                "Browser URL changed during capture",
                true,
            ));
        }
        mask_rectangles(
            &mut rgba,
            width as usize,
            height as usize,
            bounds["x"].as_i64().unwrap_or(0),
            bounds["y"].as_i64().unwrap_or(0),
            &observation["root"],
        );
        mask_rectangles(
            &mut rgba,
            width as usize,
            height as usize,
            bounds["x"].as_i64().unwrap_or(0),
            bounds["y"].as_i64().unwrap_or(0),
            &after["root"],
        );
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(unavailable)?;
            writer.write_image_data(&rgba).map_err(unavailable)?;
        }
        // Enforce the encoded capture byte quota before storing transferable PNG data.
        if bytes.len() > MAX_CAPTURE_BYTES {
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
            .ok_or_else(|| unavailable(()))?
            .capture = Some((id.clone(), bytes));
        Ok(
            json!({"captureId":id,"length":length,"mimeType":"image/png","width":width,"height":height}),
        )
    }

    /// Read a bounded chunk of a session-owned redacted capture.
    ///
    /// Args:
    ///     params (&Value): Session, capture identifier, and chunk bounds.
    /// Returns:
    ///     Result<Value, BackendError>: Base64 encoded bounded capture chunk.
    fn read_capture(&self, params: &Value) -> Result<Value, BackendError> {
        let binding = self.binding(params)?;
        let (id, bytes) = binding
            .capture
            .as_ref()
            .filter(|(id, _)| params.get("captureId").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| BackendError::new("TARGET_NOT_FOUND", "Capture is absent", false))?;
        let _ = id;
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
        // Require an in-range capture offset and a positive requested chunk size.
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

/// Intern an EWMH or X11 property atom.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     name (&str): Atom name.
/// Returns:
///     Result<u32, BackendError>: Interned atom identifier.
fn atom(connection: &RustConnection, name: &str) -> Result<u32, BackendError> {
    connection
        .intern_atom(false, name.as_bytes())
        .map_err(unavailable)?
        .reply()
        .map(|reply| reply.atom)
        .map_err(unavailable)
}

/// Retrieve a bounded 32-bit X11 property without assuming its server type.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     window (Window): Property owner.
///     name (&str): Property name.
/// Returns:
///     Result<Vec<u32>, BackendError>: Numeric property values.
fn property32(
    connection: &RustConnection,
    window: Window,
    name: &str,
) -> Result<Vec<u32>, BackendError> {
    let reply = connection
        .get_property(
            false,
            window,
            atom(connection, name)?,
            xproto::AtomEnum::ANY,
            0,
            4096,
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    Ok(reply
        .value32()
        .map(|values| values.collect())
        .unwrap_or_default())
}

/// Retrieve a bounded UTF-8 window title.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     window (Window): Property owner.
///     name (&str): Property name.
/// Returns:
///     Result<String, BackendError>: Decoded property text.
fn property_text(
    connection: &RustConnection,
    window: Window,
    name: &str,
) -> Result<String, BackendError> {
    let reply = connection
        .get_property(
            false,
            window,
            atom(connection, name)?,
            xproto::AtomEnum::ANY,
            0,
            1024,
        )
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    Ok(String::from_utf8_lossy(&reply.value).into_owned())
}

/// Confirm a process is a Chromium-family executable using procfs metadata.
///
/// Args:
///     pid (u32): Browser process identifier.
/// Returns:
///     bool: Whether the executable basename identifies a supported browser.
fn browser_process(pid: u32) -> bool {
    fs::read_link(
        std::path::Path::new("/proc")
            .join(pid.to_string())
            .join("exe"),
    )
    .ok()
    .and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    })
    .is_some_and(|name| {
        matches!(
            name.as_str(),
            "chrome" | "chromium" | "chromium-browser" | "abr-chromium"
        )
    })
}

/// Read a verified Chromium executable's own version without returning diagnostic output.
///
/// Args:
///     params (&Value): Trusted executable path supplied by the runtime launcher.
/// Returns:
///     Result<Value, BackendError>: Numeric browser version metadata.
fn browser_version(params: &Value) -> Result<Value, BackendError> {
    let path = Path::new(string(params, "executable")?);
    // Restrict process execution to the explicit browser executable family.
    if !path.is_absolute()
        || !path.file_name().is_some_and(|name| {
            matches!(
                name.to_str(),
                Some("chrome" | "chromium" | "chromium-browser" | "abr-chromium")
            )
        })
    {
        return Err(BackendError::new(
            "POLICY_DENIED",
            "Executable is outside the supported browser family",
            false,
        ));
    }
    let output = Command::new(path)
        .arg("--version")
        .output()
        .map_err(unavailable)?;
    // Reject unsuccessful execution of the selected browser version metadata command.
    if !output.status.success() {
        return Err(BackendError::new(
            "BROWSER_DISCONNECTED",
            "Browser version metadata is unavailable",
            true,
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .find(|token| {
            token
                .bytes()
                .all(|value| value.is_ascii_digit() || value == b'.')
                && token.matches('.').count() >= 2
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Browser version format is unsupported",
                false,
            )
        })?;
    Ok(json!({"version":version}))
}

/// Translate native client geometry into root-screen physical coordinates.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     root (Window): Root screen identifier.
///     window (Window): Browser client identifier.
/// Returns:
///     Result<Value, BackendError>: Screen physical rectangle.
fn window_bounds(
    connection: &RustConnection,
    root: Window,
    window: Window,
) -> Result<Value, BackendError> {
    let geometry = connection
        .get_geometry(window)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    let position = connection
        .translate_coordinates(window, root, 0, 0)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    Ok(
        json!({"x":position.dst_x,"y":position.dst_y,"width":geometry.width,"height":geometry.height}),
    )
}

/// Verify a physical point belongs to the bound client through native stacking hit testing.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     root (Window): Root screen identifier.
///     window (Window): Bound browser client.
///     x (i32): Screen physical horizontal coordinate.
///     y (i32): Screen physical vertical coordinate.
/// Returns:
///     Result<(), BackendError>: Confirmed unoccluded target point.
fn validate_point(
    connection: &RustConnection,
    root: Window,
    window: Window,
    x: i32,
    y: i32,
) -> Result<(), BackendError> {
    let mut current = root;
    let x = i16::try_from(x).map_err(|_| {
        BackendError::new(
            "INVALID_ARGUMENT",
            "X11 coordinate exceeds server range",
            false,
        )
    })?;
    let y = i16::try_from(y).map_err(|_| {
        BackendError::new(
            "INVALID_ARGUMENT",
            "X11 coordinate exceeds server range",
            false,
        )
    })?;
    // Descend actual stacking-order children rather than trusting foreground alone.
    for _ in 0..32 {
        let reply = connection
            .translate_coordinates(root, current, x, y)
            .map_err(unavailable)?
            .reply()
            .map_err(unavailable)?;
        // Accept the pointer hit when its native child window is the bound browser.
        if current == window {
            return Ok(());
        }
        // Stop native hit-test traversal when the queried point has no child window.
        if reply.child == x11rb::NONE {
            break;
        }
        current = reply.child;
    }
    Err(BackendError::new(
        "TARGET_OCCLUDED",
        "Input point is outside or occluded by another window",
        true,
    ))
}

/// Send one checked XTest event with bounded protocol coordinates.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     event (u8): X11 input event type.
///     detail (u8): Native button or keycode.
///     root (Window): Root screen identifier.
///     x (i32): Horizontal physical coordinate.
///     y (i32): Vertical physical coordinate.
/// Returns:
///     Result<(), BackendError>: Checked event dispatch.
fn fake(
    connection: &RustConnection,
    event: u8,
    detail: u8,
    root: Window,
    x: i32,
    y: i32,
) -> Result<(), BackendError> {
    let x = i16::try_from(x).map_err(unavailable)?;
    let y = i16::try_from(y).map_err(unavailable)?;
    connection
        .xtest_fake_input(event, detail, x11rb::CURRENT_TIME, root, x, y, 0)
        .map_err(unavailable)?
        .check()
        .map_err(unavailable)
}

/// Read the active server keyboard map without changing keyboard layout.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
/// Returns:
///     Result<Vec<(u8, Vec<u32>)>, BackendError>: Keycode-to-keysym groups.
fn keyboard_mapping(connection: &RustConnection) -> Result<Vec<(u8, Vec<u32>)>, BackendError> {
    let extension = xkb::use_extension(connection, 1, 0)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    // Require server XKB support before reading keyboard group and modifier state.
    if !extension.supported {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "XKB keyboard-state validation is required",
            false,
        ));
    }
    let state = xkb::get_state(connection, u16::from(xkb::ID::USE_CORE_KBD))
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    // Require the supported keyboard group and stable modifier state without changing user layout settings.
    if state.group != xkb::Group::M1 || state.locked_mods.contains(xproto::ModMask::LOCK) {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Keyboard entry requires the first XKB group and unlocked Caps Lock",
            false,
        ));
    }
    // Reject user-held or latched modifiers before preparing independent injected keys.
    if state.base_mods != xproto::ModMask::default()
        || state.latched_mods != xproto::ModMask::default()
    {
        return Err(BackendError::new(
            "DESKTOP_BUSY",
            "User-held or latched keyboard modifiers are active",
            true,
        ));
    }
    let setup = connection.setup();
    let reply = connection
        .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
        .map_err(unavailable)?
        .reply()
        .map_err(unavailable)?;
    Ok(reply
        .keysyms
        .chunks(usize::from(reply.keysyms_per_keycode))
        .enumerate()
        .map(|(index, symbols)| (setup.min_keycode + index as u8, symbols.to_vec()))
        .collect())
}

/// Resolve a keysym using the unmodified or Shift level of the current layout.
///
/// Args:
///     mapping (&[(u8, Vec<u32>)]): Server keymap.
///     symbol (u32): Desired native keysym.
/// Returns:
///     Result<(u8, bool), BackendError>: Physical keycode and Shift requirement.
fn resolve_symbol(mapping: &[(u8, Vec<u32>)], symbol: u32) -> Result<(u8, bool), BackendError> {
    // Restrict resolution to the active first keyboard group.
    for (code, symbols) in mapping {
        // Select an unshifted physical key whose current-group symbol matches the target.
        if symbols.first() == Some(&symbol) {
            return Ok((*code, false));
        }
        // Select a shifted physical key whose current-group symbol matches the target.
        if symbols.get(1) == Some(&symbol) {
            return Ok((*code, true));
        }
    }
    Err(BackendError::new(
        "UNSUPPORTED_CAPABILITY",
        "Character is absent from the active X11 keyboard group",
        false,
    ))
}

/// Send a paired key event and restore any temporary Shift state.
///
/// Args:
///     connection (&RustConnection): Current X11 connection.
///     root (Window): Root screen identifier.
///     code (u8): Physical keycode.
///     shifted (bool): Whether temporary Shift is required.
///     mapping (&[(u8, Vec<u32>)]): Server keyboard map.
/// Returns:
///     Result<(), BackendError>: Balanced keyboard event completion.
fn key_pair(
    connection: &RustConnection,
    root: Window,
    code: u8,
    shifted: bool,
    mapping: &[(u8, Vec<u32>)],
) -> Result<(), BackendError> {
    let shift = if shifted {
        Some(resolve_symbol(mapping, 0xffe1)?.0)
    } else {
        None
    };
    // Keep temporary modifiers paired on all event dispatch paths.
    if let Some(shift) = shift {
        fake(connection, xproto::KEY_PRESS_EVENT, shift, root, 0, 0)?;
    }
    let result = fake(connection, xproto::KEY_PRESS_EVENT, code, root, 0, 0)
        .and_then(|()| fake(connection, xproto::KEY_RELEASE_EVENT, code, root, 0, 0));
    // A best-effort release also covers a failed checked key-press request.
    if result.is_err() {
        let _ = fake(connection, xproto::KEY_RELEASE_EVENT, code, root, 0, 0);
    }
    // Release the temporary injected Shift key after the paired character transitions.
    if let Some(shift) = shift {
        let _ = fake(connection, xproto::KEY_RELEASE_EVENT, shift, root, 0, 0);
    }
    result
}

/// Map public named keys to X11 keysyms.
///
/// Args:
///     key (&str): Public key token.
/// Returns:
///     Result<u32, BackendError>: Native keysym.
fn key_symbol(key: &str) -> Result<u32, BackendError> {
    let result = match key {
        "Enter" => 0xff0d,
        "Tab" => 0xff09,
        "Escape" => 0xff1b,
        "Backspace" => 0xff08,
        "Delete" => 0xffff,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "Space" => 0x20,
        value if value.chars().count() == 1 => u32::from(value.chars().next().unwrap_or(' ')),
        _ => {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Physical key is unavailable",
                false,
            ));
        }
    };
    Ok(result)
}

/// Locate the AT-SPI application whose D-Bus peer process matches the trusted browser.
///
/// Args:
///     bus (&BusConnection): Accessibility bus.
///     pid (u32): Trusted browser launch process.
/// Returns:
///     Result<(String, OwnedObjectPath), BackendError>: Verified application object reference.
fn application_for_pid(
    bus: &BusConnection,
    pid: u32,
) -> Result<(String, OwnedObjectPath), BackendError> {
    let registry = Proxy::new(
        bus,
        "org.a11y.atspi.Registry",
        "/org/a11y/atspi/accessible/root",
        "org.a11y.atspi.Accessible",
    )
    .map_err(unavailable)?;
    let peers: Vec<(String, OwnedObjectPath)> =
        registry.call("GetChildren", &()).map_err(unavailable)?;
    let daemon = Proxy::new(
        bus,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .map_err(unavailable)?;
    // Bind the accessibility application by peer credentials rather than its displayed name.
    for peer in peers.into_iter().take(256) {
        let owner: u32 = daemon
            .call("GetConnectionUnixProcessID", &(peer.0.as_str(),))
            .unwrap_or(0);
        // Accept the accessibility peer only when its D-Bus owner PID matches the browser.
        if owner == pid {
            return Ok(peer);
        }
    }
    Err(BackendError::new(
        "TARGET_NOT_FOUND",
        "Browser accessibility peer is absent",
        true,
    ))
}

/// Read an AT-SPI node with strict quotas, cycle detection, and sensitive subtree redaction.
///
/// Args:
///     bus (&BusConnection): Accessibility bus.
///     peer (&str): Verified application D-Bus peer.
///     path (&OwnedObjectPath): Accessible object path.
///     depth (usize): Current traversal depth.
///     count (&mut usize): Shared node quota counter.
///     seen (&mut HashSet<String>): Visited object references.
///     started (Instant): Overall observation deadline.
///     patterns (&[String]): Trusted literal sensitive label patterns.
/// Returns:
///     Result<Value, BackendError>: Redacted public accessibility node.
#[allow(clippy::too_many_arguments)]
fn read_node(
    bus: &BusConnection,
    peer: &str,
    path: &OwnedObjectPath,
    depth: usize,
    count: &mut usize,
    seen: &mut HashSet<String>,
    started: Instant,
    patterns: &[String],
) -> Result<Value, BackendError> {
    // Terminate bounded observation before making additional remote calls.
    if depth > MAX_DEPTH
        || *count >= MAX_NODES
        || started.elapsed() > Duration::from_secs(8)
        || !seen.insert(format!("{peer}:{path}"))
    {
        return Err(BackendError::new(
            "TIMEOUT",
            "Accessibility observation limit reached",
            true,
        ));
    }
    *count += 1;
    let accessible =
        Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Accessible").map_err(unavailable)?;
    let role: String = accessible
        .call("GetRoleName", &())
        .unwrap_or_else(|_| "unknown".to_owned());
    let name: String = accessible.get_property("Name").unwrap_or_default();
    let description: String = accessible.get_property("Description").unwrap_or_default();
    let attributes: HashMap<String, String> =
        accessible.call("GetAttributes", &()).unwrap_or_default();
    let protected = role == "password text"
        || sensitive(&name, &role, patterns)
        || sensitive(&description, &role, patterns)
        || attributes
            .get("text-input-type")
            .is_some_and(|value| value == "password");
    let component =
        Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Component").map_err(unavailable)?;
    let rectangle: Result<(i32, i32, i32, i32), _> = component.call("GetExtents", &(0_u32,));
    let native_states: Vec<u32> = accessible.call("GetState", &()).unwrap_or_default();
    let mut states = Vec::new();
    // Decode AT-SPI state words using the standardized state enumeration.
    for (name, bit) in [
        ("enabled", 7),
        ("focusable", 11),
        ("focused", 12),
        ("selected", 23),
        ("showing", 25),
        ("visible", 30),
    ] {
        // Translate native AT-SPI state bits that are set into public state names.
        if native_states
            .get(bit / 32)
            .is_some_and(|word| word & (1 << (bit % 32)) != 0)
        {
            states.push(name);
        }
    }
    let mut node = json!({"nodeId":format!("linux-{}", *count),"role":role,"name":if protected {"[protected]"} else {&name},"states":states});
    // Preserve masking geometry while removing text and every sensitive descendant.
    if let Ok((x, y, width, height)) = rectangle
        && width > 0
        && height > 0
    {
        node["bounds"] =
            json!({"x":x,"y":y,"width":width,"height":height,"space":"screen-physical"});
    }
    // Return a redacted protected node before reading its text or descendants.
    if protected {
        node["states"]
            .as_array_mut()
            .unwrap()
            .push(json!("protected"));
        return Ok(node);
    }
    // Read text through the observation interface without invoking Action or EditableText.
    if matches!(
        role.as_str(),
        "text" | "entry" | "text field" | "static" | "paragraph"
    ) {
        let text =
            Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Text").map_err(unavailable)?;
        let length: i32 = text.get_property("CharacterCount").unwrap_or(0);
        // Read a bounded native text value when the AT-SPI Text call succeeds.
        if let Ok(value) = text.call::<_, _, String>("GetText", &(0_i32, length.clamp(0, 4096))) {
            node["value"] = json!(value);
        }
    }
    let children: Vec<(String, OwnedObjectPath)> =
        accessible.call("GetChildren", &()).unwrap_or_default();
    let mut output = Vec::new();
    // Reject references outside the independently credential-verified application peer.
    for (child_peer, child_path) in children.into_iter().take(MAX_NODES - *count) {
        // Keep child traversal inside the credential-verified accessibility peer.
        if child_peer != peer {
            continue;
        }
        output.push(read_node(
            bus,
            peer,
            &child_path,
            depth + 1,
            count,
            seen,
            started,
            patterns,
        )?);
    }
    node["children"] = json!(output);
    Ok(node)
}

/// Identify sensitive accessibility labels for redaction and screenshot masking.
///
/// Args:
///     text (&str): Native accessible label.
///     role (&str): Original native accessibility role.
///     patterns (&[String]): Trusted additional literal sensitive labels.
/// Returns:
///     bool: Whether the label identifies protected credentials or payment fields.
fn sensitive(text: &str, role: &str, patterns: &[String]) -> bool {
    let value = text.to_lowercase();
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
            "entry"
                | "text"
                | "text field"
                | "password text"
                | "combo box"
                | "autocomplete"
                | "spin button"
                | "check box"
                | "radio button"
                | "toggle button"
                | "switch"
                | "label"
                | "static"
                | "static text"
                | "inline text"
        ) && value
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .any(|word| word.eq_ignore_ascii_case("card")))
}

/// Read bounded literal masking labels supplied by the trusted runtime parent.
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

/// Locate a browser window using independently observed native geometry.
///
/// Args:
///     node (&Value): Application accessibility tree.
///     bounds (&Value): Bound X11 client rectangle.
/// Returns:
///     Option<&Value>: Geometry-matched native window.
fn select_window<'a>(node: &'a Value, bounds: &Value) -> Option<&'a Value> {
    let mut candidates = Vec::new();
    let mut matches = Vec::new();
    window_candidates(node, bounds, &mut candidates, &mut matches);
    let index = unique_window_index(&matches).ok()?;
    Some(candidates[index])
}

/// Compare native window rectangles while allowing the known client-decoration difference.
///
/// Args:
///     rectangle (&Value): Native or accessibility window bounds.
///     bounds (&Value): Bound X11 client rectangle.
/// Returns:
///     bool: Whether all geometry fields match within the decoration tolerance.
fn same_window_geometry(rectangle: &Value, bounds: &Value) -> bool {
    ["x", "y", "width", "height"].iter().all(|field| {
        (rectangle[*field].as_i64().unwrap_or(i64::MIN / 2) - bounds[*field].as_i64().unwrap_or(0))
            .abs()
            <= 64
    })
}

/// Gather native window candidates outside every document boundary before unique selection.
///
/// Args:
///     node (&Value): Native application accessibility node.
///     bounds (&Value): Bound X11 client rectangle.
///     candidates (&mut Vec<&Value>): Native window records.
///     matches (&mut Vec<Option<bool>>): Complete geometry-match results.
/// Returns:
///     (): Completion of document-aware native window candidate collection.
fn window_candidates<'a>(
    node: &'a Value,
    bounds: &Value,
    candidates: &mut Vec<&'a Value>,
    matches: &mut Vec<Option<bool>>,
) {
    let role = node["role"].as_str().unwrap_or("");
    // Page documents cannot contribute native top-level window identity.
    if document_boundary(UrlPlatform::Linux, role) {
        return;
    }
    // Retain unreadable native frame geometry so uniqueness validation fails closed.
    if matches!(role, "frame" | "window") {
        candidates.push(node);
        matches.push(
            node.get("bounds")
                .map(|rectangle| same_window_geometry(rectangle, bounds)),
        );
    }
    // Inspect browser application descendants while preserving the document exclusion.
    if let Some(children) = node["children"].as_array() {
        for child in children {
            window_candidates(child, bounds, candidates, matches);
        }
    }
}

/// Read private browser chrome and top-document metadata through native interfaces.
///
/// Args:
///     bus (&BusConnection): Credential-verified AT-SPI bus.
///     peer (&str): Browser-owned unique D-Bus peer name.
///     root (&OwnedObjectPath): Native application accessibility root.
///     started (Instant): Shared observation deadline.
/// Returns:
///     Result<Value, BackendError>: Internal metadata tree with document content excluded.
fn read_url_metadata(
    bus: &BusConnection,
    peer: &str,
    root: &OwnedObjectPath,
    started: Instant,
) -> Result<Value, BackendError> {
    let mut count = 0;
    let mut seen = HashSet::new();
    read_url_node(bus, peer, root, 0, false, &mut count, &mut seen, started)
}

/// Read one metadata node while stopping at every native document boundary.
///
/// Args:
///     bus (&BusConnection): Credential-verified accessibility bus.
///     peer (&str): Browser-owned unique D-Bus peer.
///     path (&OwnedObjectPath): Native accessibility object path.
///     depth (usize): Current private traversal depth.
///     toolbar (bool): Whether a native browser toolbar is an ancestor.
///     count (&mut usize): Shared private node count.
///     seen (&mut HashSet<String>): Visited native object identities.
///     started (Instant): Shared observation deadline.
/// Returns:
///     Result<Value, BackendError>: Internal native metadata with read-only URL sources.
#[allow(clippy::too_many_arguments)]
fn read_url_node(
    bus: &BusConnection,
    peer: &str,
    path: &OwnedObjectPath,
    depth: usize,
    toolbar: bool,
    count: &mut usize,
    seen: &mut HashSet<String>,
    started: Instant,
) -> Result<Value, BackendError> {
    let identity = format!("{peer}:{path}");
    // Bound private traversal before issuing any additional accessibility request.
    if depth > MAX_DEPTH
        || *count >= MAX_NODES
        || started.elapsed() > Duration::from_secs(8)
        || !seen.insert(identity.clone())
    {
        return Err(BackendError::new(
            "TIMEOUT",
            "Native URL observation limit reached",
            true,
        ));
    }
    *count += 1;
    let accessible =
        Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Accessible").map_err(unavailable)?;
    let role: String = accessible.call("GetRoleName", &()).map_err(unavailable)?;
    let mut node = json!({"nativeId":identity,"role":role});
    let component =
        Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Component").map_err(unavailable)?;
    // Retain native window and document rectangles for binding and viewport identity.
    if let Ok((x, y, width, height)) =
        component.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(0_u32,))
        && width > 0
        && height > 0
    {
        node["bounds"] =
            json!({"x":x,"y":y,"width":width,"height":height,"space":"screen-physical"});
    }
    // Read the native root document URI and exclude all page controls and embedded documents.
    if document_boundary(UrlPlatform::Linux, &role) {
        if root_document(UrlPlatform::Linux, &role) {
            let document = Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Document")
                .map_err(unavailable)?;
            if let Ok(url) = document.call::<_, _, String>("GetAttributeValue", &("URI",)) {
                node["documentUrl"] = json!(url);
            }
        }
        return Ok(node);
    }
    let toolbar = toolbar || chrome_toolbar(UrlPlatform::Linux, &role);
    // Limit fallback text reads to native editable controls within browser chrome toolbars.
    if toolbar && address_role(UrlPlatform::Linux, &role) {
        let name: String = accessible.get_property("Name").map_err(unavailable)?;
        let attributes: HashMap<String, String> =
            accessible.call("GetAttributes", &()).map_err(unavailable)?;
        node["name"] = json!(name);
        node["identifier"] = json!(attributes.get("id"));
        // Read private text exclusively for qualified native omnibox markers.
        if attributes.get("id").is_some_and(|value| value == "omnibox")
            || name == "Address and search bar"
        {
            let states: Vec<u32> = accessible.call("GetState", &()).map_err(unavailable)?;
            // Retain unknown focus state when the native state array is absent.
            if let Some(bits) = states.first() {
                node["focused"] = json!(bits & (1 << 12) != 0);
            }
            let text =
                Proxy::new(bus, peer, path.as_str(), "org.a11y.atspi.Text").map_err(unavailable)?;
            let length: i32 = text.get_property("CharacterCount").unwrap_or(0);
            // Preserve complete address values while excluding truncated or oversized candidates.
            if (1..=4096).contains(&length)
                && let Ok(value) = text.call::<_, _, String>("GetText", &(0_i32, length))
            {
                node["value"] = json!(value);
            }
        }
    }
    let children: Vec<(String, OwnedObjectPath)> =
        accessible.call("GetChildren", &()).map_err(unavailable)?;
    let mut output = Vec::new();
    // Keep private chrome traversal inside the verified native application peer.
    for (child_peer, child_path) in children {
        if child_peer != peer {
            continue;
        }
        output.push(read_url_node(
            bus,
            peer,
            &child_path,
            depth + 1,
            toolbar,
            count,
            seen,
            started,
        )?);
    }
    node["children"] = json!(output);
    Ok(node)
}

/// Require complete masking geometry for every protected native field.
///
/// Args:
///     node (&Value): Redacted accessibility tree.
/// Returns:
///     Result<(), BackendError>: Complete sensitive-region geometry validation.
fn require_mask_geometry(node: &Value) -> Result<(), BackendError> {
    // Omit the capture when native accessibility cannot locate a protected region.
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
    // Inspect accessible descendants when verifying sensitive screenshot mask geometry.
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        // Require native masking bounds for every protected descendant before PNG transfer.
        for child in children {
            require_mask_geometry(child)?;
        }
    }
    Ok(())
}

/// Convert an X11 packed image to RGBA using its server visual masks and byte order.
///
/// Args:
///     data (&[u8]): Native image bytes.
///     width (usize): Physical image width.
///     height (usize): Physical image height.
///     bits (u8): Native pixel depth in storage.
///     padding (u8): Native scanline padding in bits.
///     little_endian (bool): X11 image byte order.
///     masks ([u32; 3]): Red, green, and blue visual masks.
/// Returns:
///     Result<Vec<u8>, BackendError>: RGBA image bytes.
fn image_rgba(
    data: &[u8],
    width: usize,
    height: usize,
    bits: u8,
    padding: u8,
    little_endian: bool,
    masks: [u32; 3],
) -> Result<Vec<u8>, BackendError> {
    // Require supported pixel depth, scanline padding, and nonzero visual channel masks.
    if !matches!(bits, 16 | 24 | 32) || !matches!(padding, 8 | 16 | 32) || masks.contains(&0) {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "X11 pixel storage format is unsupported",
            false,
        ));
    }
    let pixel_bytes = usize::from(bits) / 8;
    let row = (width * usize::from(bits)).div_ceil(usize::from(padding)) * usize::from(padding) / 8;
    // Require the X11 image buffer length to equal its padded scanline allocation.
    if data.len() != row * height {
        return Err(BackendError::new(
            "INTERNAL_ERROR",
            "X11 image length is invalid",
            false,
        ));
    }
    let mut output = vec![0; width * height * 4];
    // Honor scanline padding and visual channel masks rather than assuming BGRA storage.
    for y in 0..height {
        // Convert each packed pixel in the current X11 scanline to RGBA output.
        for x in 0..width {
            let source = &data[y * row + x * pixel_bytes..y * row + (x + 1) * pixel_bytes];
            let mut pixel = 0_u32;
            // Assemble each packed pixel using the byte order declared by the X11 server.
            for (index, byte) in source.iter().enumerate() {
                let shift = if little_endian {
                    index * 8
                } else {
                    (pixel_bytes - index - 1) * 8
                };
                pixel |= u32::from(*byte) << shift;
            }
            // Scale each masked visual color channel into its eight-bit RGBA output value.
            for (channel, mask) in masks.iter().enumerate() {
                let shift = mask.trailing_zeros();
                output[(y * width + x) * 4 + channel] =
                    (u64::from((pixel & mask) >> shift) * 255 / u64::from(mask >> shift)) as u8;
            }
            output[(y * width + x) * 4 + 3] = 255;
        }
    }
    Ok(output)
}

/// Replace protected native rectangles with opaque black before any IPC transfer.
///
/// Args:
///     pixels (&mut [u8]): Owned RGBA capture bytes.
///     width (usize): Physical capture width.
///     height (usize): Physical capture height.
///     origin_x (i64): Client screen origin.
///     origin_y (i64): Client screen origin.
///     node (&Value): Redacted accessibility tree retaining protected bounds.
/// Returns:
///     (): Completion of recursive in-memory masking.
fn mask_rectangles(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    origin_x: i64,
    origin_y: i64,
    node: &Value,
) {
    // Preserve protection even when a field's visible label is itself confidential.
    if node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|state| state == "protected"))
        && let Some(bounds) = node.get("bounds")
    {
        let left = (bounds["x"].as_i64().unwrap_or(0) - origin_x).clamp(0, width as i64) as usize;
        let top = (bounds["y"].as_i64().unwrap_or(0) - origin_y).clamp(0, height as i64) as usize;
        let right = (bounds["x"].as_i64().unwrap_or(0) + bounds["width"].as_i64().unwrap_or(0)
            - origin_x)
            .clamp(0, width as i64) as usize;
        let bottom = (bounds["y"].as_i64().unwrap_or(0) + bounds["height"].as_i64().unwrap_or(0)
            - origin_y)
            .clamp(0, height as i64) as usize;
        // Visit each capture row that intersects the protected native rectangle.
        for y in top..bottom {
            // Replace each protected capture pixel with opaque black before PNG encoding.
            for x in left..right {
                pixels[(y * width + x) * 4..(y * width + x) * 4 + 4]
                    .copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
    // Inspect accessible descendants for additional protected capture rectangles.
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        // Apply sensitive-region masking recursively to every child accessibility node.
        for child in children {
            mask_rectangles(pixels, width, height, origin_x, origin_y, child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify native byte-order conversion and per-field pixel privacy boundaries.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful visual-mask and sensitive-pixel assertions.
    #[test]
    fn native_pixel_privacy() {
        let mut pixels = image_rgba(
            &[0, 0, 255, 0, 0, 255, 0, 0],
            2,
            1,
            32,
            32,
            true,
            [0xff0000, 0xff00, 0xff],
        )
        .unwrap();
        assert_eq!(pixels, [255, 0, 0, 255, 0, 255, 0, 255]);
        let node = json!({"states":["protected"],"bounds":{"x":101,"y":50,"width":1,"height":1}});
        mask_rectangles(&mut pixels, 2, 1, 100, 50, &node);
        assert_eq!(pixels, [255, 0, 0, 255, 0, 0, 0, 255]);
        assert!(image_rgba(&[0], 1, 1, 32, 32, true, [0xff0000, 0xff00, 0xff]).is_err());
    }

    /// Verify origin policy receives only fully qualified browser-owned URL sources.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful URL-source validation assertions.
    #[test]
    fn address_source_validation() {
        let public = json!({"states":["browser-address"],"value":"http://127.0.0.1:8080/"});
        assert!(trusted_browser_url(&public, UrlPlatform::Linux).is_err());
        let private = json!({"nativeId":"window","role":"frame","children":[{"nativeId":"document","role":"document web","documentUrl":"http://127.0.0.1:8080/"}]});
        assert_eq!(
            trusted_browser_url(&private, UrlPlatform::Linux)
                .unwrap()
                .url,
            "http://127.0.0.1:8080/"
        );
    }

    /// Verify Card hints use exact ASCII words in input and label roles.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful synthetic role, token-boundary, and custom-pattern assertions.
    #[test]
    fn card_label_privacy_scope() {
        // Protect field and label hints while preserving complete-word boundaries.
        for value in ["Card", "card", "CARD", "Payment Card", "Card / expiry"] {
            assert!(sensitive(value, "entry", &[]));
            assert!(sensitive(value, "label", &[]));
        }
        for value in ["Cardboard", "Cardiology", "Discard", "card2", "card_name"] {
            assert!(!sensitive(value, "entry", &[]));
        }
        for role in [
            "frame",
            "window",
            "document web",
            "document",
            "grouping",
            "push button",
            "link",
        ] {
            assert!(!sensitive("Payment Card", role, &[]));
        }
        assert!(sensitive(
            "Special Token",
            "document web",
            &["special token".to_owned()]
        ));
    }
}
