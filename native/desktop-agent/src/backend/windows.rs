// -*- coding: utf-8 -*-
//! windows.rs
//! Windows native desktop backend
//! =====================
//! Read browser accessibility and GPU window captures and inject bounded OS input.

use std::collections::HashMap;
use std::mem::size_of;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, WAIT_ABANDONED,
    WAIT_OBJECT_0, WPARAM,
};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, ReleaseMutex, TerminateProcess, WaitForSingleObject,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement,
    IUIAutomationLegacyIAccessiblePattern, IUIAutomationSelectionItemPattern,
    IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_ButtonControlTypeId,
    UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId, UIA_DocumentControlTypeId,
    UIA_EditControlTypeId, UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId,
    UIA_LegacyIAccessiblePatternId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
    UIA_MenuControlTypeId, UIA_MenuItemControlTypeId, UIA_PaneControlTypeId,
    UIA_RadioButtonControlTypeId, UIA_SelectionItemPatternId, UIA_TabControlTypeId,
    UIA_TabItemControlTypeId, UIA_TextControlTypeId, UIA_ToolBarControlTypeId, UIA_ValuePatternId,
    UIA_WindowControlTypeId,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::Ime::{
    ImmGetContext, ImmGetOpenStatus, ImmIsIME, ImmReleaseContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    MAPVK_VK_TO_VSC_EX, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MapVirtualKeyExW, SendInput, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN,
    VK_END, VK_ESCAPE, VK_HOME, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT,
    VK_SHIFT, VK_SPACE, VK_TAB, VK_UP, VkKeyScanExW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GA_ROOT, GA_ROOTOWNER, GUITHREADINFO, GetAncestor, GetClassNameW,
    GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetSystemMetrics, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KBDLLHOOKSTRUCT,
    MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, SetForegroundWindow,
    SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_QUIT,
    WindowFromPoint,
};
use windows::core::{BOOL, Interface, PCWSTR, PWSTR, factory, w};

use super::BackendError;

// Restrict traversal, input, image storage, and wire chunks to explicit limits.
const MAX_NODES: usize = 6000;
const MAX_DEPTH: usize = 32;
const MAX_TEXT_UNITS: usize = 16_384;
const MAX_PIXELS: usize = 20_000_000;
const MAX_CAPTURE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 512 * 1024;
static INPUT_EPOCH: OnceLock<Arc<AtomicU64>> = OnceLock::new();
static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
static INPUT_MARKER: AtomicUsize = AtomicUsize::new(0);
static OWNED_INPUT_COUNT: AtomicU64 = AtomicU64::new(0);
static PHYSICAL_INPUT_COUNT: AtomicU64 = AtomicU64::new(0);
static FOREIGN_INJECTED_COUNT: AtomicU64 = AtomicU64::new(0);

/// NativeHandle
/// Close an owned Win32 kernel handle when its owner is released.
struct NativeHandle(HANDLE);

/// Apartment
/// Release the initialized WinRT apartment after all native interfaces.
struct Apartment;

impl Drop for Apartment {
    /// Balance the backend's successful WinRT initialization.
    ///
    /// Args:
    ///     self: WinRT apartment owner.
    ///
    /// Returns:
    ///     None: Thread apartment ownership is released.
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

impl Drop for NativeHandle {
    /// Release the owned kernel handle.
    ///
    /// Args:
    ///     self: Handle owner.
    ///
    /// Returns:
    ///     None: The kernel reference is released.
    fn drop(&mut self) {
        // Every stored handle originates from a successful Win32 creation call.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Binding
/// Associate a trusted session with one living browser process and HWND.
struct Binding {
    hwnd: HWND,
    pid: u32,
    process: NativeHandle,
    capture: Option<Capture>,
    cancellation: Arc<AtomicU64>,
}

/// Interrupt one bound session through a thread-safe generation counter.
///
/// Args:
///     session_id: Session identifier authorized by the authenticated IPC reader.
///
/// Returns:
///     bool: Whether a live binding received the cancellation.
pub fn interrupt(session_id: &str) -> bool {
    // The reader thread updates only an atomic counter and never accesses COM.
    if let Some(cancellations) = CANCELLATIONS.get()
        && let Ok(cancellations) = cancellations.lock()
        && let Some(generation) = cancellations.get(session_id)
    {
        generation.fetch_add(1, Ordering::AcqRel);
        return true;
    }
    false
}

/// InputOperation
/// Bind one native input sequence to external-input and cancellation generations.
struct InputOperation<'a> {
    monitor: &'a InputMonitor,
    input_epoch: u64,
    cancellation_epoch: u64,
    started: Instant,
    timeout: Duration,
    foreground: HWND,
}

/// Capture
/// Retain only a privacy-filtered PNG for bounded chunk transfer.
struct Capture {
    id: String,
    bytes: Vec<u8>,
    created: Instant,
}

/// InputMonitor
/// Observe external input without changing or suppressing OS events.
struct InputMonitor {
    epoch: Arc<AtomicU64>,
    thread_id: u32,
    worker: Option<JoinHandle<()>>,
}

impl InputMonitor {
    /// Start low-level hooks on an independently pumped message thread.
    ///
    /// Args:
    ///     None: The hooks use the current interactive Windows desktop.
    ///
    /// Returns:
    ///     Result<Self, BackendError>: A monitor or an unavailable input failure.
    fn start() -> Result<Self, BackendError> {
        let epoch = INPUT_EPOCH
            .get_or_init(|| Arc::new(AtomicU64::new(0)))
            .clone();
        // Keep the marker in a nonzero DWORD range for Windows input interoperability.
        INPUT_MARKER.store(
            (0x41425200_u32 ^ std::process::id()).max(1) as usize,
            Ordering::Release,
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        // Install hooks on the thread that runs their Windows message queue.
        let worker = thread::spawn(move || unsafe {
            let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0);
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0);
            // Report a complete hook pair before advertising safe input.
            match (keyboard, mouse) {
                (Ok(keyboard), Ok(mouse)) => {
                    let mut message = MSG::default();
                    // Create the message queue before exposing its thread identifier.
                    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                    let _ = sender.send(Ok(GetCurrentThreadId()));
                    // Pump messages until the backend requests shutdown.
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
                    let _ = UnhookWindowsHookEx(keyboard);
                    let _ = UnhookWindowsHookEx(mouse);
                }
                (keyboard, mouse) => {
                    // Release a partially installed pair before reporting failure.
                    if let Ok(hook) = keyboard {
                        let _ = UnhookWindowsHookEx(hook);
                    }
                    if let Ok(hook) = mouse {
                        let _ = UnhookWindowsHookEx(hook);
                    }
                    let _ = sender.send(Err(unavailable()));
                }
            }
        });
        // Bound startup so a hook initialization failure cannot stall IPC.
        let thread_id = receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| unavailable())??;
        Ok(Self {
            epoch,
            thread_id,
            worker: Some(worker),
        })
    }
}

impl Drop for InputMonitor {
    /// Remove hooks and stop their message thread.
    ///
    /// Args:
    ///     self: Monitor owner.
    ///
    /// Returns:
    ///     None: The hook thread is joined.
    fn drop(&mut self) {
        // Request a normal Windows message-loop exit before joining.
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        // Consume the join handle once during destruction.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Observe an unowned keyboard event and continue the hook chain.
///
/// Args:
///     code: Windows hook event status.
///     parameter: Keyboard message identifier.
///     event: Pointer to the low-level keyboard data.
///
/// Returns:
///     LRESULT: The next hook's result.
unsafe extern "system" fn keyboard_hook(code: i32, parameter: WPARAM, event: LPARAM) -> LRESULT {
    // Read event data only for notifications that Windows marks actionable.
    if code >= 0 {
        let data = unsafe { &*(event.0 as *const KBDLLHOOKSTRUCT) };
        // Count every event whose marker belongs to another input source.
        if data.dwExtraInfo != INPUT_MARKER.load(Ordering::Acquire)
            && let Some(epoch) = INPUT_EPOCH.get()
        {
            epoch.fetch_add(1, Ordering::AcqRel);
            // Record safe event counts without key codes, characters, or user data.
            if data.flags.0 & 0x10 != 0 {
                FOREIGN_INJECTED_COUNT.fetch_add(1, Ordering::AcqRel);
            } else {
                PHYSICAL_INPUT_COUNT.fetch_add(1, Ordering::AcqRel);
            }
        } else {
            OWNED_INPUT_COUNT.fetch_add(1, Ordering::AcqRel);
        }
    }
    unsafe { CallNextHookEx(None, code, parameter, event) }
}

/// Observe an unowned mouse event and continue the hook chain.
///
/// Args:
///     code: Windows hook event status.
///     parameter: Mouse message identifier.
///     event: Pointer to the low-level mouse data.
///
/// Returns:
///     LRESULT: The next hook's result.
unsafe extern "system" fn mouse_hook(code: i32, parameter: WPARAM, event: LPARAM) -> LRESULT {
    // Read event data only for notifications that Windows marks actionable.
    if code >= 0 {
        let data = unsafe { &*(event.0 as *const MSLLHOOKSTRUCT) };
        // Count every event whose marker belongs to another input source.
        if data.dwExtraInfo != INPUT_MARKER.load(Ordering::Acquire)
            && let Some(epoch) = INPUT_EPOCH.get()
        {
            epoch.fetch_add(1, Ordering::AcqRel);
            // Record safe event counts without coordinates, buttons, or user data.
            if data.flags & 0x01 != 0 {
                FOREIGN_INJECTED_COUNT.fetch_add(1, Ordering::AcqRel);
            } else {
                PHYSICAL_INPUT_COUNT.fetch_add(1, Ordering::AcqRel);
            }
        } else {
            OWNED_INPUT_COUNT.fetch_add(1, Ordering::AcqRel);
        }
    }
    unsafe { CallNextHookEx(None, code, parameter, event) }
}

/// DesktopLease
/// Serialize input across ABR processes on the current Windows login session.
struct DesktopLease(NativeHandle);

impl DesktopLease {
    /// Acquire the input seat without waiting behind another owner.
    ///
    /// Args:
    ///     None: The mutex is scoped to the Windows logon session.
    ///
    /// Returns:
    ///     Result<Self, BackendError>: The lease or a desktop busy error.
    fn acquire() -> Result<Self, BackendError> {
        // Windows applies the creating token's default security descriptor.
        let handle = unsafe { CreateMutexW(None, false, w!("Local\\ABR.DesktopInput.v1")) }
            .map_err(|_| unavailable())?;
        let handle = NativeHandle(handle);
        let state = unsafe { WaitForSingleObject(handle.0, 0) };
        // An abandoned mutex transfers ownership and permits state revalidation.
        if state != WAIT_OBJECT_0 && state != WAIT_ABANDONED {
            return Err(BackendError::new(
                "DESKTOP_BUSY",
                "Another desktop input owner holds the seat",
                true,
            ));
        }
        Ok(Self(handle))
    }
}

impl Drop for DesktopLease {
    /// Release the current desktop input owner.
    ///
    /// Args:
    ///     self: Acquired mutex owner.
    ///
    /// Returns:
    ///     None: The seat is available to another process.
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0.0);
        }
    }
}

/// DesktopBackend
/// Execute Windows observation and input for explicitly bound browser windows.
pub struct DesktopBackend {
    automation: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    bindings: HashMap<String, Binding>,
    monitor: Option<InputMonitor>,
    capture_serial: u64,
    _apartment: Apartment,
}

impl DesktopBackend {
    /// Initialize bounded UI Automation and per-monitor coordinate semantics.
    ///
    /// Args:
    ///     None: Initialization uses the current Windows desktop and token.
    ///
    /// Returns:
    ///     Result<Self, BackendError>: The initialized native backend.
    pub fn new() -> Result<Self, BackendError> {
        // Initialize COM and WinRT on the thread that owns backend dispatch.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| unavailable())?;
        let apartment = Apartment;
        let previous_dpi =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous_dpi.0.is_null() {
            return Err(unavailable());
        }
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .map_err(|_| unavailable())?;
        // Modern UIA clients expose provider connection and transaction timeouts.
        let automation2: IUIAutomation2 = automation.cast().map_err(|_| unavailable())?;
        unsafe {
            automation2
                .SetConnectionTimeout(1500)
                .map_err(|_| unavailable())?;
            automation2
                .SetTransactionTimeout(1500)
                .map_err(|_| unavailable())?;
        }
        let walker = unsafe { automation.ControlViewWalker() }.map_err(|_| unavailable())?;
        // A monitor failure leaves observation available and input explicitly unavailable.
        let monitor = InputMonitor::start().ok();
        Ok(Self {
            automation,
            walker,
            bindings: HashMap::new(),
            monitor,
            capture_serial: 0,
            _apartment: apartment,
        })
    }

    /// Dispatch an authenticated desktop request through the Windows backend.
    ///
    /// Args:
    ///     method: Explicit internal IPC method.
    ///     params: Validated object containing method parameters.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: Method output or a stable safe error.
    pub fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, BackendError> {
        // Route named operations without interpreting arbitrary executable payloads.
        match method {
            "desktop.doctor" => Ok(self.doctor()),
            "desktop.browserVersion" => browser_version(required_string(params, "executable")?),
            "desktop.listWindows" => list_windows(
                params
                    .get("pid")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
            ),
            "desktop.bind" => self.bind(params),
            "desktop.closeProcess" => self.close_process(params),
            "desktop.unbind" => {
                let session = required_string(params, "sessionId")?;
                self.bindings.remove(session);
                if let Some(cancellations) = CANCELLATIONS.get()
                    && let Ok(mut cancellations) = cancellations.lock()
                {
                    cancellations.remove(session);
                }
                Ok(json!({}))
            }
            "desktop.observe" => self.observe(params),
            "desktop.currentUrl" => self.current_url(params),
            "desktop.capture" => self.capture(params),
            "desktop.readCapture" => self.read_capture(params),
            "desktop.focus" => self.focus(params),
            "desktop.input" => self.input(params),
            "desktop.chooseFile" => self.choose_file(params),
            "desktop.cancel" => {
                self.binding(params)?;
                Ok(json!({"cancelled": interrupt(required_string(params, "sessionId")?)}))
            }
            // IME and file dialog semantic adapters retain explicit capability gating.
            _ => Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "The desktop method is unavailable",
                false,
            )),
        }
    }

    /// Report implemented paths and runtime support without generating input.
    ///
    /// Args:
    ///     self: Native backend.
    ///
    /// Returns:
    ///     Value: Runtime capability and permission metadata.
    fn doctor(&self) -> Value {
        let capture = GraphicsCaptureSession::IsSupported().unwrap_or(false);
        let input = self.monitor.is_some();
        json!({"schemaVersion":1,"platform":"windows","agentVersion":env!("CARGO_PKG_VERSION"),"accessibility":true,"screenCapture":capture,"input":input,"atomicNavigate":true,"pointer":input,"keyboard":input,"tabs":true,"ime":false,"imeContext":ime_state(unsafe { GetForegroundWindow() }).report(),"fileDialog":input,"captureBackend":"windows-graphics-capture","inputBackend":"SendInput","dpiAwareness":"per-monitor-v2","inputMonitor":{"owned":OWNED_INPUT_COUNT.load(Ordering::Acquire),"physical":PHYSICAL_INPUT_COUNT.load(Ordering::Acquire),"foreignInjected":FOREIGN_INJECTED_COUNT.load(Ordering::Acquire)},"permissions":{"accessibility":"available","screenCapture":if capture {"available"} else {"unavailable"},"input":if input {"subject-to-uipi"} else {"unavailable"}},"unsupported":{"input.ime":"System IME composition requires a separate tested adapter"}})
    }

    /// Bind a trusted launcher PID to one currently owned browser window.
    ///
    /// Args:
    ///     params: Session ID, browser process ID, and opaque HWND identifier.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: The validated window metadata.
    fn bind(&mut self, params: &Value) -> Result<Value, BackendError> {
        let session = required_string(params, "sessionId")?.to_owned();
        let pid = required_u32(params, "pid")?;
        let hwnd = parse_window(required_string(params, "windowId")?)?;
        // Bound process handles prevent recycled PIDs from acquiring an old session.
        let process = browser_process(pid, true)?;
        validate_hwnd(hwnd, pid)?;
        let info = window_info(hwnd, pid)?;
        // Reject rebinding so session authority remains immutable.
        if self.bindings.contains_key(&session) || self.bindings.len() >= 16 {
            return Err(BackendError::new(
                "INVALID_ARGUMENT",
                "The desktop session binding is already allocated",
                false,
            ));
        }
        let cancellation = Arc::new(AtomicU64::new(0));
        CANCELLATIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| unavailable())?
            .insert(session.clone(), cancellation.clone());
        self.bindings.insert(
            session,
            Binding {
                hwnd,
                pid,
                process,
                capture: None,
                cancellation,
            },
        );
        Ok(info)
    }

    /// Resolve a binding and validate that the original browser remains alive.
    ///
    /// Args:
    ///     params: Request containing a session identifier.
    ///
    /// Returns:
    ///     Result<&Binding, BackendError>: The immutable browser binding.
    fn binding(&self, params: &Value) -> Result<&Binding, BackendError> {
        let binding = self
            .bindings
            .get(required_string(params, "sessionId")?)
            .ok_or_else(|| {
                BackendError::new(
                    "SESSION_NOT_FOUND",
                    "The desktop session is unavailable",
                    false,
                )
            })?;
        // A signaled process handle identifies termination even when its PID is recycled.
        if unsafe { WaitForSingleObject(binding.process.0, 0) } == WAIT_OBJECT_0 {
            return Err(disconnected());
        }
        validate_hwnd(binding.hwnd, binding.pid)?;
        Ok(binding)
    }

    /// End the original bound browser process through its retained kernel identity handle.
    ///
    /// Args:
    ///     params: Authenticated owned session identifier.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: Verified original-process termination acknowledgement.
    fn close_process(&self, params: &Value) -> Result<Value, BackendError> {
        let session = required_string(params, "sessionId")?;
        let binding = self.bindings.get(session).ok_or_else(|| {
            BackendError::new(
                "SESSION_NOT_FOUND",
                "The desktop session is unavailable",
                false,
            )
        })?;
        // Cancel only this binding's subsequent input before process cleanup.
        interrupt(session);
        // The retained original process remains distinct from later recycled PIDs or HWNDs.
        if unsafe { WaitForSingleObject(binding.process.0, 0) } == WAIT_OBJECT_0 {
            return Ok(json!({"closed":true,"processEnded":true}));
        }
        // Use only cleanup authority retained when this trusted binding was established.
        unsafe { TerminateProcess(binding.process.0, 0) }.map_err(|_|BackendError::new("PERMISSION_REQUIRED","The original owned browser process could not be terminated with current permissions",false))?;
        // Require kernel completion before the runtime releases its profile lease.
        if unsafe { WaitForSingleObject(binding.process.0, 5000) } != WAIT_OBJECT_0 {
            return Err(BackendError::new(
                "TIMEOUT",
                "The original owned browser process did not end within its deadline",
                false,
            ));
        }
        Ok(json!({"closed":true,"processEnded":true}))
    }

    /// Read a filtered UIA control tree and an authoritative browser address field.
    ///
    /// Args:
    ///     params: Bound session and optional sensitive label patterns.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: Physical-coordinate browser observation.
    fn observe(&self, params: &Value) -> Result<Value, BackendError> {
        let binding = self.binding(params)?;
        let info = window_info(binding.hwnd, binding.pid)?;
        let root = unsafe { self.automation.ElementFromHandle(binding.hwnd) }
            .map_err(|_| disconnected())?;
        let mut observation = Observation::new(params);
        // Resolve trusted browser URL metadata independently from public subtree redaction.
        self.read_address(&root, 0, false, &mut observation)?;
        observation.nodes = 0;
        observation.started = Instant::now();
        // Read-only UIA properties provide observation without invoking control actions.
        let root = self.read_node(&root, "root", 0, false, false, &mut observation)?;
        // Prefer provider-owned current document metadata over editable address-bar text.
        let url = observation_url(&observation)?;
        let bounds = &info["bounds"];
        let viewport = observation.viewport.unwrap_or((
            bounds["x"].as_i64().unwrap_or(0) as i32,
            bounds["y"].as_i64().unwrap_or(0) as i32,
        ));
        Ok(
            json!({"windowId":window_id(binding.hwnd),"root":root,"url":url,"scale":{"dpr":info["scale"],"zoom":1.0},"geometry":{"windowOrigin":{"x":bounds["x"],"y":bounds["y"]},"viewportOrigin":{"x":viewport.0,"y":viewport.1},"monitorScale":info["scale"],"viewportMetricsVerified":false},"sensitiveBounds":observation.sensitive.iter().map(rect_value).collect::<Vec<_>>()}),
        )
    }

    /// Read only authoritative current URL metadata for origin policy checks.
    ///
    /// Args:
    ///     params: Bound session identity.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: The current verified browser address.
    fn current_url(&self, params: &Value) -> Result<Value, BackendError> {
        let binding = self.binding(params)?;
        let root = unsafe { self.automation.ElementFromHandle(binding.hwnd) }
            .map_err(|_| disconnected())?;
        let mut address = Observation::new(params);
        // Origin checks query browser metadata without serializing rendered AX content.
        self.read_address(&root, 0, false, &mut address)?;
        Ok(json!({"url":observation_url(&address)?}))
    }

    /// Read authoritative browser URL metadata without traversing rendered document descendants.
    ///
    /// Args:
    ///     element: Current element inside the verified browser window.
    ///     depth: Bounded browser chrome traversal depth.
    ///     toolbar: Whether a browser chrome toolbar is an ancestor.
    ///     observation: Private document and address-bar URL discovery state.
    ///
    /// Returns:
    ///     Result<(), BackendError>: Trusted URL metadata discovery status.
    fn read_address(
        &self,
        element: &IUIAutomationElement,
        depth: usize,
        toolbar: bool,
        observation: &mut Observation,
    ) -> Result<(), BackendError> {
        // Limit metadata discovery separately from the complete public AX inventory.
        if observation.nodes >= 1500
            || depth > MAX_DEPTH
            || observation.started.elapsed() > Duration::from_secs(4)
        {
            return Err(BackendError::new(
                "TIMEOUT",
                "Browser address metadata discovery exceeded its limits",
                true,
            ));
        }
        observation.nodes += 1;
        let control = unsafe { element.CurrentControlType() }.map_err(|_| stale())?;
        let offscreen = unsafe { element.CurrentIsOffscreen() }
            .map_err(|_| stale())?
            .as_bool();
        // A top-level RootWebArea exposes provider-owned URL metadata through read-only patterns.
        if control == UIA_DocumentControlTypeId {
            let identifier = unsafe { element.CurrentAutomationId() }
                .map_err(|_| stale())?
                .to_string();
            if !offscreen && identifier == "RootWebArea" && observation.document_url.is_none() {
                observation.document_url = document_url(element);
            }
            // Web document controls have no authority to identify browser chrome address fields.
            return Ok(());
        }
        let toolbar = toolbar || control == UIA_ToolBarControlTypeId;
        // Limit editable value reads to the browser's labelled omnibox outside web content.
        if toolbar
            && !offscreen
            && (control == UIA_EditControlTypeId || control == UIA_ComboBoxControlTypeId)
        {
            let name = unsafe { element.CurrentName() }
                .map_err(|_| stale())?
                .to_string();
            if address_name(&name) {
                let focused = unsafe { element.CurrentHasKeyboardFocus() }
                    .map_err(|_| stale())?
                    .as_bool();
                if let Ok(pattern) = unsafe {
                    element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                } && let Ok(value) = unsafe { pattern.CurrentValue() }
                {
                    let url = verified_url(&value.to_string()).ok();
                    if observation
                        .url
                        .as_ref()
                        .zip(url.as_ref())
                        .is_some_and(|(current, url)| current != url)
                    {
                        return Err(BackendError::new(
                            "POLICY_DENIED",
                            "The browser address observation is ambiguous",
                            false,
                        ));
                    }
                    observation.url = url;
                    observation.address_focused = focused;
                }
            }
        }
        let mut child = walker_element(&self.walker, element, true)?;
        // Walk only browser-chrome relationships with original COM success/null semantics.
        while let Some(element) = child {
            self.read_address(&element, depth + 1, toolbar, observation)?;
            child = walker_element(&self.walker, &element, false)?;
        }
        Ok(())
    }

    /// Recursively read bounded control properties while removing protected subtrees.
    ///
    /// Args:
    ///     element: UIA element in the verified browser tree.
    ///     path: Snapshot-local stable tree path.
    ///     depth: Current recursion depth.
    ///     toolbar: Whether the ancestor chain is browser toolbar chrome.
    ///     document: Whether an ancestor belongs to untrusted rendered web content.
    ///     observation: Limits, address, viewport, and sensitive rectangle state.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: A filtered accessibility node.
    fn read_node(
        &self,
        element: &IUIAutomationElement,
        path: &str,
        depth: usize,
        toolbar: bool,
        document: bool,
        observation: &mut Observation,
    ) -> Result<Value, BackendError> {
        // Fail the whole read when bounds prevent a complete privacy inventory.
        if observation.nodes >= MAX_NODES
            || depth > MAX_DEPTH
            || observation.started.elapsed() > Duration::from_secs(6)
        {
            return Err(BackendError::new(
                "TIMEOUT",
                "The accessibility observation exceeded its limits",
                true,
            ));
        }
        observation.nodes += 1;
        let control = unsafe { element.CurrentControlType() }.map_err(|_| stale())?;
        let bounds = unsafe { element.CurrentBoundingRectangle() }.map_err(|_| stale())?;
        let password = unsafe { element.CurrentIsPassword() }
            .map_err(|_| stale())?
            .as_bool();
        let name = unsafe { element.CurrentName() }
            .map_err(|_| stale())?
            .to_string();
        let protected = password || sensitive_control(control.0, &name, &observation.patterns);
        let enabled = unsafe { element.CurrentIsEnabled() }
            .map_err(|_| stale())?
            .as_bool();
        let offscreen = unsafe { element.CurrentIsOffscreen() }
            .map_err(|_| stale())?
            .as_bool();
        let focused = unsafe { element.CurrentHasKeyboardFocus() }
            .map_err(|_| stale())?
            .as_bool();
        // Read only the top-level browser document, excluding nested rendered document roles.
        if control == UIA_DocumentControlTypeId && !document && !offscreen {
            let identifier = unsafe { element.CurrentAutomationId() }
                .map_err(|_| stale())?
                .to_string();
            if identifier == "RootWebArea" {
                let url = document_url(element);
                // A navigation between URL discovery and AX reading invalidates this observation.
                if observation
                    .document_url
                    .as_ref()
                    .zip(url.as_ref())
                    .is_some_and(|(current, url)| current != url)
                {
                    return Err(stale());
                }
                if observation.document_url.is_none() {
                    observation.document_url = url;
                }
            }
        }
        let mut states = Vec::new();
        // Expose state labels without leaking protected names, values, or descendants.
        if !enabled {
            states.push("disabled");
        }
        if offscreen {
            states.push("offscreen");
        }
        if focused {
            states.push("focused");
        }
        // Native tab selection is observation metadata and carries browser-chrome authority.
        if control == UIA_TabItemControlTypeId {
            if let Ok(pattern) = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
            } && unsafe { pattern.CurrentIsSelected() }
                .unwrap_or_default()
                .as_bool()
            {
                states.push("selected");
            }
            if !document {
                states.push("browser-tab");
            }
        }
        if protected {
            states.push("protected");
            observation.sensitive.push(bounds);
        }
        let mut node = json!({"nodeId":format!("uia-{path}"),"role":role(control.0),"states":states,"bounds":{"x":bounds.left,"y":bounds.top,"width":(bounds.right-bounds.left).max(0),"height":(bounds.bottom-bounds.top).max(0),"space":"screen-physical"}});
        // A protected subtree is reduced before it can cross the IPC boundary.
        if protected {
            return Ok(node);
        }
        node["name"] = Value::String(name.chars().take(1024).collect());
        // Rendered document descendants cannot identify an authoritative browser toolbar.
        let document = document || control == UIA_DocumentControlTypeId;
        let toolbar = (toolbar || control == UIA_ToolBarControlTypeId) && !document;
        // ValuePattern is used exclusively to read current text, including the omnibox.
        if (control == UIA_EditControlTypeId || control == UIA_ComboBoxControlTypeId)
            && let Ok(pattern) = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            }
            && let Ok(value) = unsafe { pattern.CurrentValue() }
        {
            let value = value.to_string();
            // Identify the address field by browser-chrome ancestry and its label.
            if toolbar && address_name(&name) {
                let url = verified_url(&value).ok();
                // Multiple different address fields are rejected instead of silently overriding authority.
                if observation
                    .url
                    .as_ref()
                    .zip(url.as_ref())
                    .is_some_and(|(current, url)| current != url)
                {
                    return Err(BackendError::new(
                        "POLICY_DENIED",
                        "The browser address observation is ambiguous",
                        false,
                    ));
                }
                observation.url = url;
                observation.address_focused = focused;
            }
            node["value"] = Value::String(value.chars().take(2048).collect());
        }
        // Browser document bounds define the viewport origin in physical coordinates.
        if control == UIA_DocumentControlTypeId && !offscreen && observation.viewport.is_none() {
            observation.viewport = Some((bounds.left, bounds.top));
        }
        let mut children = Vec::new();
        let mut child = walker_element(&self.walker, element, true)?;
        // Walk the UIA control view with snapshot-local node identifiers.
        while let Some(element) = child {
            let index = children.len();
            children.push(self.read_node(
                &element,
                &format!("{path}-{index}"),
                depth + 1,
                toolbar,
                document,
                observation,
            )?);
            child = walker_element(&self.walker, &element, false)?;
        }
        // Include children only for composite controls.
        if !children.is_empty() {
            node["children"] = Value::Array(children);
        }
        Ok(node)
    }

    /// Request foreground ownership using the normal Windows focus policy.
    ///
    /// Args:
    ///     params: Bound session identifier.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: Foreground verification metadata.
    fn focus(&self, params: &Value) -> Result<Value, BackendError> {
        let _lease = DesktopLease::acquire()?;
        let binding = self.binding(params)?;
        // Restore an owned minimized browser without changing OS security settings.
        if unsafe { IsIconic(binding.hwnd) }.as_bool() {
            unsafe {
                let _ = ShowWindow(binding.hwnd, SW_RESTORE);
            }
        }
        unsafe {
            let _ = SetForegroundWindow(binding.hwnd);
        }
        // Windows may legitimately reject focus acquisition under its foreground lock.
        if unsafe { GetForegroundWindow() } != binding.hwnd {
            return Err(focus_lost());
        }
        Ok(json!({"foreground":true,"windowId":window_id(binding.hwnd)}))
    }

    /// Capture the bound GPU-composited window and mask protected physical rectangles.
    ///
    /// Args:
    ///     params: Bound session and optional sensitive label patterns.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: Metadata for a filtered PNG held in memory.
    fn capture(&mut self, params: &Value) -> Result<Value, BackendError> {
        let observed = self.observe(params)?;
        let binding = self.binding(params)?;
        let hwnd = binding.hwnd;
        let mut capture_rect = RECT::default();
        // DWM visible frame bounds align window capture pixels with UIA screen coordinates.
        unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut capture_rect as *mut RECT as *mut _,
                size_of::<RECT>() as u32,
            )
        }
        .map_err(|_| unavailable())?;
        let (mut pixels, width, height) = capture_wgc(hwnd)?;
        let masks = observed["sensitiveBounds"]
            .as_array()
            .ok_or_else(unavailable)?;
        // Replace sensitive rectangles before PNG encoding or IPC transfer.
        for mask in masks {
            let left = mask["x"].as_i64().unwrap_or(0) - i64::from(capture_rect.left);
            let top = mask["y"].as_i64().unwrap_or(0) - i64::from(capture_rect.top);
            let right = left + mask["width"].as_i64().unwrap_or(0);
            let bottom = top + mask["height"].as_i64().unwrap_or(0);
            mask_pixels(&mut pixels, width, height, left, top, right, bottom);
        }
        let bytes = encode_png(&pixels, width, height)?;
        // Zero the raw pixel buffer before retaining only the sanitized image.
        pixels.fill(0);
        self.capture_serial = self.capture_serial.wrapping_add(1);
        let capture_id = format!("win-capture-{}", self.capture_serial);
        let length = bytes.len();
        let session = required_string(params, "sessionId")?;
        self.bindings
            .get_mut(session)
            .ok_or_else(disconnected)?
            .capture = Some(Capture {
            id: capture_id.clone(),
            bytes,
            created: Instant::now(),
        });
        Ok(
            json!({"captureId":capture_id,"length":length,"mimeType":"image/png","width":width,"height":height}),
        )
    }

    /// Read a bounded portion of the session's current sanitized image.
    ///
    /// Args:
    ///     params: Session, capture identifier, offset, and requested byte limit.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: A base64 chunk and transfer positions.
    fn read_capture(&self, params: &Value) -> Result<Value, BackendError> {
        let binding = self.binding(params)?;
        let capture = binding.capture.as_ref().ok_or_else(stale)?;
        // Expire captures and prevent IDs from being read through another session.
        if capture.id != required_string(params, "captureId")?
            || capture.created.elapsed() > Duration::from_secs(30)
        {
            return Err(stale());
        }
        let offset = required_u32(params, "offset")? as usize;
        let maximum = required_u32(params, "maxBytes")? as usize;
        // Validate chunk bounds before creating an encoded wire buffer.
        if offset > capture.bytes.len() || maximum == 0 || maximum > MAX_CHUNK_BYTES {
            return Err(invalid());
        }
        let end = (offset + maximum).min(capture.bytes.len());
        Ok(
            json!({"data":STANDARD.encode(&capture.bytes[offset..end]),"offset":offset,"nextOffset":end,"totalBytes":capture.bytes.len(),"eof":end==capture.bytes.len()}),
        )
    }

    /// Inject a bounded operation after acquiring and validating the desktop seat.
    ///
    /// Args:
    ///     params: Bound session and an explicit physical input operation.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: The actual OS input strategy.
    fn input(&self, params: &Value) -> Result<Value, BackendError> {
        let monitor = self.monitor.as_ref().ok_or_else(unavailable)?;
        let _lease = DesktopLease::acquire()?;
        let binding = self.binding(params)?;
        let timeout = params
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(15_000);
        if timeout == 0 || timeout > 60_000 {
            return Err(invalid());
        }
        let operation = InputOperation {
            monitor,
            input_epoch: monitor.epoch.load(Ordering::Acquire),
            cancellation_epoch: binding.cancellation.load(Ordering::Acquire),
            started: Instant::now(),
            timeout: Duration::from_millis(timeout),
            foreground: binding.hwnd,
        };
        verify_input(binding, &operation)?;
        // Existing physical modifier or mouse presses indicate user ownership of input.
        for key in [
            VK_SHIFT,
            VK_CONTROL,
            VK_MENU,
            VK_LWIN,
            VIRTUAL_KEY(1),
            VIRTUAL_KEY(2),
            VIRTUAL_KEY(4),
        ] {
            if unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0 {
                return Err(BackendError::new(
                    "DESKTOP_BUSY",
                    "Physical input is active on the desktop",
                    true,
                ));
            }
        }
        let kind = required_string(params, "kind")?;
        // Each operation has one explicit OS implementation and retains paired releases.
        match kind {
            "navigate" => {
                let url = required_string(params, "url")?;
                // Require a complete bounded HTTP address before acquiring browser address focus.
                if url.len() > 8192
                    || !(url.starts_with("http://") || url.starts_with("https://"))
                    || url.chars().any(char::is_whitespace)
                    || url.chars().any(char::is_control)
                {
                    return Err(invalid());
                }
                let focus_keys = key_chord("Control+L")?;
                let enter_keys = key_chord("Enter")?;
                let text_keys = url.chars().map(unicode_keys).collect::<Vec<_>>();
                // Preserve one desktop lease and interruption generation for the whole navigation.
                send_checked(binding, &operation, &focus_keys)?;
                for inputs in text_keys {
                    send_checked(binding, &operation, &inputs)?;
                    thread::sleep(Duration::from_millis(3));
                }
                send_checked(binding, &operation, &enter_keys)?;
                return Ok(json!({"actualStrategy":"os-unicode"}));
            }
            "click" | "doubleClick" | "move" => {
                let x = required_i32(params, "x")?;
                let y = required_i32(params, "y")?;
                pointer_target(binding, x, y)?;
                send_checked(binding, &operation, &[mouse_move(x, y)?])?;
                // A move has no button transition.
                if kind != "move" {
                    let (down, up) = mouse_button(
                        params
                            .get("button")
                            .and_then(Value::as_str)
                            .unwrap_or("left"),
                    )?;
                    let count = if kind == "doubleClick" { 2 } else { 1 };
                    // Check ownership separately before each complete click pair.
                    for _ in 0..count {
                        send_checked(
                            binding,
                            &operation,
                            &[mouse_event(down, 0), mouse_event(up, 0)],
                        )?;
                    }
                }
            }
            "scroll" => {
                let x = required_i32(params, "x")?;
                let y = required_i32(params, "y")?;
                pointer_target(binding, x, y)?;
                let horizontal = required_i32(params, "deltaX")?;
                let vertical = required_i32(params, "deltaY")?;
                // Bound Windows wheel units and retain CSS-style positive-down semantics.
                if horizontal.unsigned_abs() > 12_000 || vertical.unsigned_abs() > 12_000 {
                    return Err(invalid());
                }
                send_checked(binding, &operation, &[mouse_move(x, y)?])?;
                if vertical != 0 {
                    send_checked(
                        binding,
                        &operation,
                        &[mouse_event(MOUSEEVENTF_WHEEL, (-vertical) as u32)],
                    )?;
                }
                if horizontal != 0 {
                    send_checked(
                        binding,
                        &operation,
                        &[mouse_event(MOUSEEVENTF_HWHEEL, horizontal as u32)],
                    )?;
                }
            }
            "key" => {
                let inputs = key_chord(required_string(params, "key")?)?;
                send_checked(binding, &operation, &inputs)?;
            }
            "text" => {
                let text = required_string(params, "text")?;
                let strategy = params
                    .get("strategy")
                    .and_then(Value::as_str)
                    .unwrap_or("unicode");
                // Explicit IME composition requires a separately validated adapter.
                if strategy == "ime" {
                    return Err(BackendError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "System IME composition is unavailable",
                        false,
                    ));
                }
                if text.encode_utf16().count() > MAX_TEXT_UNITS {
                    return Err(invalid());
                }
                let keyboard = strategy == "keyboard";
                if !keyboard && strategy != "unicode" && strategy != "auto" {
                    return Err(invalid());
                }
                // Physical text requires a verified inactive IME before any key is inserted.
                if keyboard && !ime_state(binding.hwnd).physical_text_allowed() {
                    return Err(BackendError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "Physical keyboard text requires a verified inactive IME",
                        false,
                    ));
                }
                // Validate every layout mapping before beginning irreversible text input.
                let characters = text
                    .chars()
                    .map(|character| {
                        if keyboard {
                            character_keys(character)
                        } else {
                            Ok(unicode_keys(character))
                        }
                    })
                    .collect::<Result<Vec<_>, BackendError>>()?;
                // Preserve cancellation and external-input checks between characters.
                for inputs in characters {
                    send_checked(binding, &operation, &inputs)?;
                    thread::sleep(Duration::from_millis(3));
                }
                return Ok(
                    json!({"actualStrategy":if keyboard {"os-keyboard"} else {"os-unicode"}}),
                );
            }
            "drag" => {
                let x = required_i32(params, "x")?;
                let y = required_i32(params, "y")?;
                let end_x = required_i32(params, "endX")?;
                let end_y = required_i32(params, "endY")?;
                pointer_target(binding, x, y)?;
                pointer_target(binding, end_x, end_y)?;
                send_checked(
                    binding,
                    &operation,
                    &[mouse_move(x, y)?, mouse_event(MOUSEEVENTF_LEFTDOWN, 0)],
                )?;
                // Guarantee a release even when a user or another window interrupts the drag.
                let movement = (|| {
                    // Interpolate in physical pixels for a bounded drag trajectory.
                    for step in 1..=20 {
                        let next_x = x + ((i64::from(end_x) - i64::from(x)) * step / 20) as i32;
                        let next_y = y + ((i64::from(end_y) - i64::from(y)) * step / 20) as i32;
                        pointer_target(binding, next_x, next_y)?;
                        send_checked(binding, &operation, &[mouse_move(next_x, next_y)?])?;
                        thread::sleep(Duration::from_millis(10));
                    }
                    Ok::<(), BackendError>(())
                })();
                let released = send_raw(&[mouse_event(MOUSEEVENTF_LEFTUP, 0)]);
                movement?;
                released?;
            }
            _ => {
                return Err(BackendError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "The input operation is unavailable",
                    false,
                ));
            }
        }
        Ok(if kind == "key" {
            json!({"actualStrategy":"os-keyboard"})
        } else {
            json!({})
        })
    }

    /// Select one approved file in the browser's currently owned common file dialog.
    ///
    /// Args:
    ///     params: Session and a core-policy-approved absolute local file path.
    ///
    /// Returns:
    ///     Result<Value, BackendError>: Submission metadata after the dialog closes.
    fn choose_file(&self, params: &Value) -> Result<Value, BackendError> {
        let path = required_string(params, "path")?;
        // Apply lexical bounds before accessing any candidate filesystem path.
        if path.len() > 4096
            || path.contains('\0')
            || path.starts_with("\\\\")
            || !Path::new(path).is_absolute()
            || !Path::new(path).is_file()
        {
            return Err(invalid());
        }
        let monitor = self.monitor.as_ref().ok_or_else(unavailable)?;
        let _lease = DesktopLease::acquire()?;
        let binding = self.binding(params)?;
        let dialog = unsafe { GetForegroundWindow() };
        validate_dialog(binding, dialog)?;
        let operation = InputOperation {
            monitor,
            input_epoch: monitor.epoch.load(Ordering::Acquire),
            cancellation_epoch: binding.cancellation.load(Ordering::Acquire),
            started: Instant::now(),
            timeout: Duration::from_secs(6),
            foreground: dialog,
        };
        verify_input(binding, &operation)?;
        let root = unsafe { self.automation.ElementFromHandle(dialog) }.map_err(|_| stale())?;
        let mut fields = Vec::new();
        // Read the native file-name control identity without invoking its UIA patterns.
        self.filename_fields(&root, false, 0, &mut fields)?;
        if fields.len() != 1 {
            return Err(BackendError::new(
                "TARGET_NOT_FOUND",
                "The owned file dialog filename field is ambiguous or unavailable",
                true,
            ));
        }
        let bounds = fields[0];
        let x = bounds.left + (bounds.right - bounds.left) / 2;
        let y = bounds.top + (bounds.bottom - bounds.top) / 2;
        pointer_window_target(dialog, x, y)?;
        send_checked(
            binding,
            &operation,
            &[
                mouse_move(x, y)?,
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0),
                mouse_event(MOUSEEVENTF_LEFTUP, 0),
            ],
        )?;
        send_checked(binding, &operation, &key_chord("Control+A")?)?;
        // Submit the path through tagged OS Unicode packets with per-character cancellation.
        for character in path.chars() {
            send_checked(binding, &operation, &unicode_keys(character))?;
        }
        send_checked(binding, &operation, &key_chord("Enter")?)?;
        // Verify the owned selector closes before reporting a completed selection.
        loop {
            if !unsafe { IsWindow(Some(dialog)) }.as_bool()
                || !unsafe { IsWindowVisible(dialog) }.as_bool()
            {
                return Ok(json!({"dialogClosed":true,"actualStrategy":"os-unicode"}));
            }
            verify_input(binding, &operation)?;
            thread::sleep(Duration::from_millis(25));
        }
    }

    /// Locate visible filename edit controls under the native file dialog host.
    ///
    /// Args:
    ///     element: UIA element within the verified common file dialog.
    ///     filename_host: Whether an ancestor identifies the filename control host.
    ///     depth: Bounded native dialog tree depth.
    ///     fields: Output physical rectangles for unambiguous edit controls.
    ///
    /// Returns:
    ///     Result<(), BackendError>: Filename-control discovery status.
    fn filename_fields(
        &self,
        element: &IUIAutomationElement,
        filename_host: bool,
        depth: usize,
        fields: &mut Vec<RECT>,
    ) -> Result<(), BackendError> {
        // Limit native dialog discovery independently from browser tree traversal.
        if depth > 16 || fields.len() > 4 {
            return Err(stale());
        }
        let identifier = unsafe { element.CurrentAutomationId() }
            .map_err(|_| stale())?
            .to_string();
        let name = unsafe { element.CurrentName() }
            .map_err(|_| stale())?
            .to_string()
            .to_lowercase();
        let control = unsafe { element.CurrentControlType() }.map_err(|_| stale())?;
        let filename_host = filename_host
            || identifier == "FileNameControlHost"
            || identifier == "1148"
            || identifier == "1152"
            || name.starts_with("file name")
            || name.starts_with("\u{6587}\u{4ef6}\u{540d}");
        // Ignore hidden controls and password providers during selector discovery.
        if unsafe { element.CurrentIsOffscreen() }
            .map_err(|_| stale())?
            .as_bool()
            || unsafe { element.CurrentIsPassword() }
                .map_err(|_| stale())?
                .as_bool()
        {
            return Ok(());
        }
        // Return only visible filename edit fields with a measurable click target.
        if control == UIA_EditControlTypeId
            && filename_host
            && unsafe { element.CurrentIsEnabled() }
                .map_err(|_| stale())?
                .as_bool()
        {
            let bounds = unsafe { element.CurrentBoundingRectangle() }.map_err(|_| stale())?;
            if bounds.right > bounds.left && bounds.bottom > bounds.top {
                fields.push(bounds);
            }
        }
        let mut child = walker_element(&self.walker, element, true)?;
        // The native dialog has a small bounded control tree.
        while let Some(element) = child {
            self.filename_fields(&element, filename_host, depth + 1, fields)?;
            child = walker_element(&self.walker, &element, false)?;
        }
        Ok(())
    }
}

impl Drop for DesktopBackend {
    /// Release UIA objects, input monitors, and COM ownership in order.
    ///
    /// Args:
    ///     self: Backend owner on its initialization thread.
    ///
    /// Returns:
    ///     None: Backend resources are released.
    fn drop(&mut self) {
        self.monitor.take();
        // Remove cancellation handles before native binding resources are released.
        if let Some(cancellations) = CANCELLATIONS.get()
            && let Ok(mut cancellations) = cancellations.lock()
        {
            for session in self.bindings.keys() {
                cancellations.remove(session);
            }
        }
    }
}

/// Observation
/// Track complete accessibility traversal and protected capture rectangles.
struct Observation {
    started: Instant,
    nodes: usize,
    url: Option<String>,
    document_url: Option<String>,
    address_focused: bool,
    viewport: Option<(i32, i32)>,
    sensitive: Vec<RECT>,
    patterns: Vec<String>,
}

impl Observation {
    /// Initialize bounded traversal state and trusted sensitive label patterns.
    ///
    /// Args:
    ///     params: Desktop request parameters.
    ///
    /// Returns:
    ///     Self: Empty observation state.
    fn new(params: &Value) -> Self {
        let patterns = params
            .get("sensitivePatterns")
            .and_then(Value::as_array)
            .map(|patterns| {
                patterns
                    .iter()
                    .filter_map(Value::as_str)
                    .take(64)
                    .map(str::to_lowercase)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            started: Instant::now(),
            nodes: 0,
            url: None,
            document_url: None,
            address_focused: false,
            viewport: None,
            sensitive: Vec::new(),
            patterns,
        }
    }
}

/// Enumerate visible Chrome-family top-level windows with optional PID filtering.
///
/// Args:
///     pid: Trusted browser process filter.
///
/// Returns:
///     Result<Value, BackendError>: Browser window metadata array.
fn list_windows(pid: Option<u32>) -> Result<Value, BackendError> {
    let mut state = WindowEnumeration {
        pid,
        windows: Vec::new(),
    };
    unsafe {
        EnumWindows(
            Some(enumerate_window),
            LPARAM(&mut state as *mut WindowEnumeration as isize),
        )
    }
    .map_err(|_| unavailable())?;
    Ok(Value::Array(state.windows))
}

/// WindowEnumeration
/// Carry owned collection state through the synchronous EnumWindows callback.
struct WindowEnumeration {
    pid: Option<u32>,
    windows: Vec<Value>,
}

/// Collect browser window metadata in the caller's bounded enumeration state.
///
/// Args:
///     hwnd: Enumerated top-level window.
///     state: Pointer to the synchronous enumeration state.
///
/// Returns:
///     BOOL: Whether Windows should continue enumeration.
unsafe extern "system" fn enumerate_window(hwnd: HWND, state: LPARAM) -> BOOL {
    let state = unsafe { &mut *(state.0 as *mut WindowEnumeration) };
    // Restrict inventory to visible Chrome browser windows and bounded results.
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() || state.windows.len() >= 64 {
        return BOOL(1);
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    // Optional filtering avoids probing unrelated applications for owned sessions.
    if state.pid.is_some_and(|wanted| wanted != pid) {
        return BOOL(1);
    }
    if browser_process(pid, false).is_err() || validate_hwnd(hwnd, pid).is_err() {
        return BOOL(1);
    }
    if let Ok(info) = window_info(hwnd, pid) {
        state.windows.push(info);
    }
    BOOL(1)
}

/// Open a living Chrome-family process without requesting privileged access.
///
/// Args:
///     pid: Browser process identifier.
///     terminate: Whether the trusted session binding also owns process cleanup authority.
///
/// Returns:
///     Result<NativeHandle, BackendError>: A retained process identity handle.
fn browser_process(pid: u32, terminate: bool) -> Result<NativeHandle, BackendError> {
    let mut rights = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    // Read-only inventory uses query rights; a trusted binding retains scoped cleanup authority.
    if terminate {
        rights |= PROCESS_TERMINATE;
    }
    let process = NativeHandle(unsafe { OpenProcess(rights, false, pid) }.map_err(|_| {
        if terminate {
            BackendError::new(
                "PERMISSION_REQUIRED",
                "The browser binding requires owned-process cleanup permissions",
                false,
            )
        } else {
            disconnected()
        }
    })?);
    let mut path = vec![0_u16; 32768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(|_| disconnected())?;
    let path = String::from_utf16_lossy(&path[..length as usize]);
    let name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Browser executable identity supplements the trusted launcher's exact PID binding.
    if name != "chrome.exe" && name != "chromium.exe" {
        return Err(BackendError::new(
            "POLICY_DENIED",
            "The process is outside the browser allowlist",
            false,
        ));
    }
    Ok(process)
}

/// Read a browser executable's embedded PE file version without launching it.
///
/// Args:
///     executable: Trusted launcher-selected browser executable path.
///
/// Returns:
///     Result<Value, BackendError>: Four-component embedded file version.
fn browser_version(executable: &str) -> Result<Value, BackendError> {
    // Validate the path shape before passing it to a null-terminated Win32 API.
    if executable.len() > 32760 || executable.contains('\0') {
        return Err(invalid());
    }
    let path = Path::new(executable);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.is_absolute() || (name != "chrome.exe" && name != "chromium.exe") {
        return Err(invalid());
    }
    let wide = executable
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let length = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if length == 0 || length > 1024 * 1024 {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "The browser file version metadata is unavailable",
            false,
        ));
    }
    // Allocate aligned storage for the version resource and validate the returned view.
    let mut resource = vec![0_u32; (length as usize).div_ceil(size_of::<u32>())];
    unsafe {
        GetFileVersionInfoW(
            PCWSTR(wide.as_ptr()),
            None,
            length,
            resource.as_mut_ptr().cast(),
        )
    }
    .map_err(|_| unavailable())?;
    let mut view = std::ptr::null_mut();
    let mut view_length = 0;
    if !unsafe {
        VerQueryValueW(
            resource.as_ptr().cast(),
            w!("\\"),
            &mut view,
            &mut view_length,
        )
    }
    .as_bool()
        || view_length < size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return Err(unavailable());
    }
    let start = resource.as_ptr() as usize;
    let view_start = view as usize;
    if view_start < start
        || view_start
            .checked_add(size_of::<VS_FIXEDFILEINFO>())
            .is_none_or(|end| end > start + length as usize)
    {
        return Err(unavailable());
    }
    let version = unsafe { std::ptr::read_unaligned(view.cast::<VS_FIXEDFILEINFO>()) };
    if version.dwSignature != 0xfeef04bd {
        return Err(unavailable());
    }
    Ok(
        json!({"version":format!("{}.{}.{}.{}", version.dwFileVersionMS >> 16, version.dwFileVersionMS & 0xffff, version.dwFileVersionLS >> 16, version.dwFileVersionLS & 0xffff)}),
    )
}

/// Verify the window still belongs to the bound browser process.
///
/// Args:
///     hwnd: Browser window handle.
///     pid: Expected owner process identifier.
///
/// Returns:
///     Result<(), BackendError>: Ownership verification status.
fn validate_hwnd(hwnd: HWND, pid: u32) -> Result<(), BackendError> {
    let mut current_pid = 0;
    // HWND and PID checks are repeated immediately before native input.
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(disconnected());
    }
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut current_pid));
    }
    let mut class = [0_u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut class) };
    if current_pid != pid
        || String::from_utf16_lossy(&class[..length.max(0) as usize]) != "Chrome_WidgetWin_1"
    {
        return Err(disconnected());
    }
    Ok(())
}

/// Read browser window geometry in physical virtual-desktop pixels.
///
/// Args:
///     hwnd: Verified browser window.
///     pid: Browser owner process identifier.
///
/// Returns:
///     Result<Value, BackendError>: Window identity, title, bounds, and DPI scale.
fn window_info(hwnd: HWND, pid: u32) -> Result<Value, BackendError> {
    let mut bounds = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut bounds) }.map_err(|_| disconnected())?;
    let mut title = [0_u16; 1024];
    let length = unsafe { GetWindowTextW(hwnd, &mut title) };
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    // A missing DPI value identifies an invalid window rather than an assumed scale.
    if dpi == 0 {
        return Err(disconnected());
    }
    Ok(
        json!({"windowId":window_id(hwnd),"pid":pid,"title":String::from_utf16_lossy(&title[..length.max(0) as usize]),"bounds":rect_value(&bounds),"scale":f64::from(dpi)/96.0,"foreground":unsafe { GetForegroundWindow() } == hwnd}),
    )
}

/// Format an HWND without exposing raw pointers as JSON numbers.
///
/// Args:
///     hwnd: Browser handle.
///
/// Returns:
///     String: An opaque architecture-safe identifier.
fn window_id(hwnd: HWND) -> String {
    format!("hwnd-{:x}", hwnd.0 as usize)
}

/// Parse a Windows handle identifier using a bounded hexadecimal representation.
///
/// Args:
///     identifier: Opaque window identifier.
///
/// Returns:
///     Result<HWND, BackendError>: The parsed handle.
fn parse_window(identifier: &str) -> Result<HWND, BackendError> {
    let value = identifier
        .strip_prefix("hwnd-")
        .filter(|value| !value.is_empty() && value.len() <= size_of::<usize>() * 2)
        .ok_or_else(invalid)?;
    let value = usize::from_str_radix(value, 16).map_err(|_| invalid())?;
    if value == 0 {
        return Err(invalid());
    }
    Ok(HWND(value as *mut _))
}

/// Validate browser and input ownership before a SendInput batch.
///
/// Args:
///     binding: Original browser process/window binding.
///     operation: Cancellation, deadline, and external input lease state.
///
/// Returns:
///     Result<(), BackendError>: Safe input ownership status.
fn verify_input(binding: &Binding, operation: &InputOperation<'_>) -> Result<(), BackendError> {
    validate_hwnd(binding.hwnd, binding.pid)?;
    if unsafe { WaitForSingleObject(binding.process.0, 0) } == WAIT_OBJECT_0 {
        return Err(disconnected());
    }
    // A file selector may own foreground only after its browser owner is verified.
    if operation.foreground != binding.hwnd {
        validate_dialog(binding, operation.foreground)?;
    }
    if unsafe { GetForegroundWindow() } != operation.foreground {
        return Err(focus_lost());
    }
    // Stop subsequent input after a user or another injector changes the seat.
    if operation.monitor.epoch.load(Ordering::Acquire) != operation.input_epoch {
        return Err(BackendError::new(
            "DESKTOP_BUSY",
            "External input interrupted the desktop operation",
            true,
        ));
    }
    if binding.cancellation.load(Ordering::Acquire) != operation.cancellation_epoch
        || operation.started.elapsed() > operation.timeout
    {
        return Err(BackendError::new(
            "TIMEOUT",
            "The native input operation was cancelled or exceeded its deadline",
            false,
        ));
    }
    Ok(())
}

/// Ensure the pointer hits an exposed area of the verified browser window.
///
/// Args:
///     binding: Browser window binding.
///     x: Physical virtual-desktop horizontal coordinate.
///     y: Physical virtual-desktop vertical coordinate.
///
/// Returns:
///     Result<(), BackendError>: Visibility and hit-test verification.
fn pointer_target(binding: &Binding, x: i32, y: i32) -> Result<(), BackendError> {
    pointer_window_target(binding.hwnd, x, y)
}

/// Verify the pointer lands inside an exposed browser or browser-owned native dialog.
///
/// Args:
///     hwnd: Previously verified browser or owned dialog handle.
///     x: Physical horizontal pointer coordinate.
///     y: Physical vertical pointer coordinate.
///
/// Returns:
///     Result<(), BackendError>: Physical bounds and occlusion verification.
fn pointer_window_target(hwnd: HWND, x: i32, y: i32) -> Result<(), BackendError> {
    let mut bounds = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut bounds) }.map_err(|_| disconnected())?;
    if x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom {
        return Err(BackendError::new(
            "TARGET_NOT_FOUND",
            "The pointer target is outside the browser window",
            false,
        ));
    }
    let hit = unsafe { WindowFromPoint(POINT { x, y }) };
    if unsafe { GetAncestor(hit, GA_ROOT) } != hwnd {
        return Err(BackendError::new(
            "TARGET_OCCLUDED",
            "The browser target is covered by another window",
            true,
        ));
    }
    Ok(())
}

/// Verify a common file selector belongs to the original browser process and owner.
///
/// Args:
///     binding: Bound browser process and primary window.
///     dialog: Current native dialog handle.
///
/// Returns:
///     Result<(), BackendError>: Exclusive dialog ownership verification.
fn validate_dialog(binding: &Binding, dialog: HWND) -> Result<(), BackendError> {
    let mut pid = 0;
    // A closed selector cannot retain input authority.
    if !unsafe { IsWindow(Some(dialog)) }.as_bool() {
        return Err(focus_lost());
    }
    unsafe {
        GetWindowThreadProcessId(dialog, Some(&mut pid));
    }
    let mut class = [0_u16; 256];
    let length = unsafe { GetClassNameW(dialog, &mut class) };
    // Require both the original browser PID and the complete native owner chain.
    if pid != binding.pid
        || String::from_utf16_lossy(&class[..length.max(0) as usize]) != "#32770"
        || unsafe { GetAncestor(dialog, GA_ROOTOWNER) } != binding.hwnd
    {
        return Err(BackendError::new(
            "FOCUS_LOST",
            "The foreground dialog is outside the bound browser ownership",
            false,
        ));
    }
    Ok(())
}

/// Send one paired input batch after validating seat ownership.
///
/// Args:
///     binding: Browser identity.
///     operation: Cancellation, deadline, and external input lease state.
///     inputs: Bounded Windows input records.
///
/// Returns:
///     Result<(), BackendError>: OS insertion status.
fn send_checked(
    binding: &Binding,
    operation: &InputOperation<'_>,
    inputs: &[INPUT],
) -> Result<(), BackendError> {
    verify_input(binding, operation)?;
    send_raw(inputs)
}

/// Insert native input and verify every record was accepted by Windows.
///
/// Args:
///     inputs: Native records with paired key/button releases.
///
/// Returns:
///     Result<(), BackendError>: Insertion status subject to Windows UIPI.
fn send_raw(inputs: &[INPUT]) -> Result<(), BackendError> {
    let inserted = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) } as usize;
    // Windows does not reliably distinguish UIPI blocking through GetLastError.
    if inserted != inputs.len() {
        // Release only keys and buttons whose own down record was accepted.
        let mut releases = Vec::new();
        for input in inputs[..inserted.min(inputs.len())].iter().rev() {
            // Input records in a partial batch belong to this operation's marker.
            unsafe {
                if input.r#type == INPUT_KEYBOARD
                    && !input.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP)
                {
                    let mut release = *input;
                    release.Anonymous.ki.dwFlags |= KEYEVENTF_KEYUP;
                    releases.push(release);
                } else if input.r#type == INPUT_MOUSE {
                    let flags = input.Anonymous.mi.dwFlags;
                    if flags.contains(MOUSEEVENTF_LEFTDOWN) {
                        releases.push(mouse_event(MOUSEEVENTF_LEFTUP, 0));
                    }
                    if flags.contains(MOUSEEVENTF_RIGHTDOWN) {
                        releases.push(mouse_event(MOUSEEVENTF_RIGHTUP, 0));
                    }
                    if flags.contains(MOUSEEVENTF_MIDDLEDOWN) {
                        releases.push(mouse_event(MOUSEEVENTF_MIDDLEUP, 0));
                    }
                }
            }
        }
        if !releases.is_empty() {
            unsafe {
                SendInput(&releases, size_of::<INPUT>() as i32);
            }
        }
        return Err(BackendError::new(
            "INPUT_BACKEND_UNAVAILABLE",
            "Windows rejected native input; verify desktop and integrity permissions",
            true,
        ));
    }
    Ok(())
}

/// Construct an absolute physical mouse move across the full virtual desktop.
///
/// Args:
///     x: Screen physical horizontal coordinate, including negative monitors.
///     y: Screen physical vertical coordinate.
///
/// Returns:
///     Result<INPUT, BackendError>: A normalized Windows virtual-desktop move.
fn mouse_move(x: i32, y: i32) -> Result<INPUT, BackendError> {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 1
        || height <= 1
        || x < origin_x
        || y < origin_y
        || i64::from(x) >= i64::from(origin_x) + i64::from(width)
        || i64::from(y) >= i64::from(origin_y) + i64::from(height)
    {
        return Err(invalid());
    }
    let mut event = mouse_event(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        0,
    );
    // Scale physical pixels to Windows' inclusive absolute-coordinate range.
    event.Anonymous.mi.dx =
        ((i64::from(x) - i64::from(origin_x)) * 65535 / i64::from(width - 1)) as i32;
    event.Anonymous.mi.dy =
        ((i64::from(y) - i64::from(origin_y)) * 65535 / i64::from(height - 1)) as i32;
    Ok(event)
}

/// Construct a tagged mouse record for click, wheel, or move input.
///
/// Args:
///     flags: Explicit Windows mouse operation flags.
///     data: Wheel or button data.
///
/// Returns:
///     INPUT: A record recognized as ABR-owned by the monitor.
fn mouse_event(
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    data: u32,
) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INPUT_MARKER.load(Ordering::Acquire),
            },
        },
    }
}

/// Map a public mouse button to paired Windows flags.
///
/// Args:
///     button: Left, right, or middle button name.
///
/// Returns:
///     Result<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS), BackendError>: Paired flags.
fn mouse_button(
    button: &str,
) -> Result<
    (
        windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
        windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    ),
    BackendError,
> {
    match button {
        "left" => Ok((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
        "right" => Ok((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
        "middle" => Ok((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
        _ => Err(invalid()),
    }
}

/// Build a physical scan-code key record for the foreground keyboard layout.
///
/// Args:
///     key: Windows virtual key mapped through the target keyboard layout.
///     up: Whether the event releases the key.
///
/// Returns:
///     Result<INPUT, BackendError>: Tagged physical keyboard input.
fn physical_key(key: VIRTUAL_KEY, up: bool) -> Result<INPUT, BackendError> {
    let thread = unsafe { GetWindowThreadProcessId(GetForegroundWindow(), None) };
    let layout = unsafe { GetKeyboardLayout(thread) };
    let scan = unsafe { MapVirtualKeyExW(u32::from(key.0), MAPVK_VK_TO_VSC_EX, Some(layout)) };
    if scan == 0 {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "The keyboard layout cannot map this key",
            false,
        ));
    }
    let mut flags = KEYEVENTF_SCANCODE;
    if scan & 0xff00 != 0 {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    Ok(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: (scan & 0xff) as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INPUT_MARKER.load(Ordering::Acquire),
            },
        },
    })
}

/// Convert a key chord to ordered modifier presses and reverse-order releases.
///
/// Args:
///     chord: Public key expression such as Control+L or Tab.
///
/// Returns:
///     Result<Vec<INPUT>, BackendError>: A complete physical key batch.
fn key_chord(chord: &str) -> Result<Vec<INPUT>, BackendError> {
    let names = chord.split('+').collect::<Vec<_>>();
    if names.is_empty() || names.len() > 5 {
        return Err(invalid());
    }
    let mut keys = Vec::new();
    // Parse a closed set of modifiers and key names with an optional ASCII key.
    for (index, name) in names.iter().enumerate() {
        let key = match *name {
            "Control" | "Ctrl" | "ControlOrMeta" => VK_CONTROL,
            "Shift" => VK_SHIFT,
            "Alt" => VK_MENU,
            "Meta" | "Win" => VK_LWIN,
            "Enter" | "Return" => VK_RETURN,
            "Tab" => VK_TAB,
            "Escape" | "Esc" => VK_ESCAPE,
            "Backspace" => VK_BACK,
            "Delete" => VK_DELETE,
            "Space" => VK_SPACE,
            "ArrowLeft" | "Left" => VK_LEFT,
            "ArrowRight" | "Right" => VK_RIGHT,
            "ArrowUp" | "Up" => VK_UP,
            "ArrowDown" | "Down" => VK_DOWN,
            "Home" => VK_HOME,
            "End" => VK_END,
            "PageUp" => VK_PRIOR,
            "PageDown" => VK_NEXT,
            name if name.starts_with('F') => {
                let number = name[1..].parse::<u16>().map_err(|_| invalid())?;
                if !(1..=24).contains(&number) {
                    return Err(invalid());
                }
                VIRTUAL_KEY(0x70 + number - 1)
            }
            name if name.len() == 1 && name.as_bytes()[0].is_ascii_alphanumeric() => {
                VIRTUAL_KEY(u16::from(name.as_bytes()[0].to_ascii_uppercase()))
            }
            _ => return Err(invalid()),
        };
        if index + 1 < names.len() && ![VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN].contains(&key) {
            return Err(invalid());
        }
        if keys.contains(&key) {
            return Err(invalid());
        }
        keys.push(key);
    }
    let mut inputs = Vec::new();
    for key in &keys {
        inputs.push(physical_key(*key, false)?);
    }
    for key in keys.iter().rev() {
        inputs.push(physical_key(*key, true)?);
    }
    Ok(inputs)
}

/// Map one character through the foreground physical keyboard layout.
///
/// Args:
///     character: Text character requested with the keyboard strategy.
///
/// Returns:
///     Result<Vec<INPUT>, BackendError>: Physical key and modifier events.
fn character_keys(character: char) -> Result<Vec<INPUT>, BackendError> {
    // The physical space key has a dedicated mapping independent of character layout lookup.
    if character == ' ' {
        return key_chord("Space");
    }
    if character == '\n' {
        return key_chord("Enter");
    }
    if character == '\t' {
        return key_chord("Tab");
    }
    if u32::from(character) > u32::from(u16::MAX) {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "The keyboard layout cannot map this character",
            false,
        ));
    }
    let thread = unsafe { GetWindowThreadProcessId(GetForegroundWindow(), None) };
    let code = unsafe { VkKeyScanExW(character as u16, GetKeyboardLayout(thread)) };
    if code == -1 {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "The keyboard layout cannot map this character",
            false,
        ));
    }
    let modifiers = ((code as u16) >> 8) & 7;
    let mut keys = Vec::new();
    if modifiers & 1 != 0 {
        keys.push(VK_SHIFT);
    }
    if modifiers & 2 != 0 {
        keys.push(VK_CONTROL);
    }
    if modifiers & 4 != 0 {
        keys.push(VK_MENU);
    }
    keys.push(VIRTUAL_KEY((code as u16) & 0xff));
    let mut inputs = Vec::new();
    for key in &keys {
        inputs.push(physical_key(*key, false)?);
    }
    for key in keys.iter().rev() {
        inputs.push(physical_key(*key, true)?);
    }
    Ok(inputs)
}

/// Construct paired Unicode text submission events, including surrogate pairs.
///
/// Args:
///     character: Unicode scalar value.
///
/// Returns:
///     Vec<INPUT>: Windows Unicode packets with explicit releases.
fn unicode_keys(character: char) -> Vec<INPUT> {
    let mut units = [0_u16; 2];
    let mut inputs = Vec::new();
    for unit in character.encode_utf16(&mut units) {
        for up in [false, true] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: *unit,
                        dwFlags: if up {
                            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                        } else {
                            KEYEVENTF_UNICODE
                        },
                        time: 0,
                        dwExtraInfo: INPUT_MARKER.load(Ordering::Acquire),
                    },
                },
            });
        }
    }
    inputs
}

/// ImeState
/// Report read-only keyboard layout and available input context metadata.
struct ImeState {
    layout: usize,
    language_id: u16,
    layout_is_ime: bool,
    open_status: Option<bool>,
}

impl ImeState {
    /// Decide whether physical text can bypass an active or unverified IME context.
    ///
    /// Args:
    ///     self: Read-only layout and context metadata.
    ///
    /// Returns:
    ///     bool: Whether physical text has a verified compatible input context.
    fn physical_text_allowed(&self) -> bool {
        // A measured open context intercepts physical character keys.
        if let Some(open) = self.open_status {
            return !open;
        }
        let primary_language = self.language_id & 0x03ff;
        // TSF contexts can lack an external IMM handle; preserve the uncertainty for CJK layouts.
        !self.layout_is_ime && !matches!(primary_language, 0x04 | 0x11 | 0x12)
    }

    /// Serialize only safe language and context state metadata.
    ///
    /// Args:
    ///     self: Read-only input method metadata.
    ///
    /// Returns:
    ///     Value: Layout, language, measured open status, and physical text availability.
    fn report(&self) -> Value {
        json!({"hkl":format!("{:x}",self.layout),"languageId":self.language_id,"layoutIsIme":self.layout_is_ime,"openStatus":self.open_status,"openStatusVerified":self.open_status.is_some(),"physicalTextAllowed":self.physical_text_allowed()})
    }
}

/// Read the active browser GUI thread's layout and available focused input context.
///
/// Args:
///     window: Active browser or current foreground window for doctor metadata.
///
/// Returns:
///     ImeState: Read-only context metadata with explicit measurement availability.
fn ime_state(window: HWND) -> ImeState {
    let thread = unsafe { GetWindowThreadProcessId(window, None) };
    let layout = unsafe { GetKeyboardLayout(thread) };
    let mut information = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    // Prefer the actual focused child so browser UI and page text stores are distinguished.
    let focused = if unsafe { GetGUIThreadInfo(thread, &mut information) }.is_ok()
        && !information.hwndFocus.0.is_null()
    {
        information.hwndFocus
    } else {
        window
    };
    let context = unsafe { ImmGetContext(focused) };
    let open_status = if context.0.is_null() {
        None
    } else {
        // Borrow and release the IMM context without changing its input mode or composition.
        let open = unsafe { ImmGetOpenStatus(context) }.as_bool();
        unsafe {
            let _ = ImmReleaseContext(focused, context);
        }
        Some(open)
    };
    ImeState {
        layout: layout.0 as usize,
        language_id: (layout.0 as usize & 0xffff) as u16,
        layout_is_ime: unsafe { ImmIsIME(layout) }.as_bool(),
        open_status,
    }
}

/// Capture one modern GPU window frame using Windows Graphics Capture.
///
/// Args:
///     hwnd: Verified browser HWND.
///
/// Returns:
///     Result<(Vec<u8>, u32, u32), BackendError>: In-memory RGBA pixels and dimensions.
fn capture_wgc(hwnd: HWND) -> Result<(Vec<u8>, u32, u32), BackendError> {
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Windows Graphics Capture is unavailable",
            false,
        ));
    }
    let mut device = None;
    let mut context = None;
    // Prefer GPU capture and retain the official WARP path for device availability.
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        if unsafe {
            D3D11CreateDevice(
                None,
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .is_ok()
        {
            break;
        }
    }
    let device: ID3D11Device = device.ok_or_else(unavailable)?;
    let context: ID3D11DeviceContext = context.ok_or_else(unavailable)?;
    let dxgi: IDXGIDevice = device.cast().map_err(|_| unavailable())?;
    let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .and_then(|value| value.cast())
        .map_err(|_| unavailable())?;
    let interop: IGraphicsCaptureItemInterop =
        factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|_| unavailable())?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }.map_err(|_| {
        BackendError::new(
            "PERMISSION_REQUIRED",
            "The browser window cannot be captured with current permissions",
            true,
        )
    })?;
    let size = item.Size().map_err(|_| unavailable())?;
    if size.Width <= 0
        || size.Height <= 0
        || (size.Width as usize).saturating_mul(size.Height as usize) > MAX_PIXELS
    {
        return Err(invalid());
    }
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )
    .map_err(|_| unavailable())?;
    let session = pool
        .CreateCaptureSession(&item)
        .map_err(|_| unavailable())?;
    // Keep the normal Windows capture indicator and permission behavior intact.
    session.StartCapture().map_err(|_| unavailable())?;
    let started = Instant::now();
    let result = (|| {
        // Poll a bounded free-threaded frame pool without a UI dispatcher dependency.
        loop {
            if let Ok(frame) = pool.TryGetNextFrame() {
                let surface = frame.Surface().map_err(|_| unavailable())?;
                let access: IDirect3DDxgiInterfaceAccess =
                    surface.cast().map_err(|_| unavailable())?;
                let texture: ID3D11Texture2D =
                    unsafe { access.GetInterface() }.map_err(|_| unavailable())?;
                let content = frame.ContentSize().map_err(|_| unavailable())?;
                let result =
                    read_texture(&device, &context, &texture, content.Width, content.Height);
                let _ = frame.Close();
                return result;
            }
            if started.elapsed() > Duration::from_secs(3) {
                return Err(BackendError::new(
                    "TIMEOUT",
                    "The window capture frame was unavailable within its deadline",
                    true,
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    // Close the session and pool on success and every bounded failure path.
    let _ = session.Close();
    let _ = pool.Close();
    result
}

/// Copy a GPU texture to a bounded CPU staging surface and normalize RGBA pixels.
///
/// Args:
///     device: Capture D3D11 device.
///     context: Immediate D3D11 context.
///     texture: Captured GPU texture.
///     width: Frame content width.
///     height: Frame content height.
///
/// Returns:
///     Result<(Vec<u8>, u32, u32), BackendError>: Complete RGBA frame pixels.
fn read_texture(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
    width: i32,
    height: i32,
) -> Result<(Vec<u8>, u32, u32), BackendError> {
    let mut description = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut description);
    }
    if width <= 0
        || height <= 0
        || width as u32 > description.Width
        || height as u32 > description.Height
        || (width as usize).saturating_mul(height as usize) > MAX_PIXELS
    {
        return Err(invalid());
    }
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.MiscFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    let mut staging = None;
    unsafe { device.CreateTexture2D(&description, None, Some(&mut staging)) }
        .map_err(|_| unavailable())?;
    let staging = staging.ok_or_else(unavailable)?;
    unsafe {
        context.CopyResource(&staging, texture);
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|_| unavailable())?;
    let result = (|| {
        // Reject unexpected row pitch before reading any mapped pointer.
        if mapped.pData.is_null() || (mapped.RowPitch as usize) < width as usize * 4 {
            return Err(unavailable());
        }
        let mut pixels = vec![0_u8; width as usize * height as usize * 4];
        // Copy each row to remove GPU padding and convert BGRA to RGBA.
        for row in 0..height as usize {
            let source = unsafe {
                std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                    width as usize * 4,
                )
            };
            let target = &mut pixels[row * width as usize * 4..(row + 1) * width as usize * 4];
            for (source, target) in source
                .as_chunks::<4>()
                .0
                .iter()
                .zip(target.as_chunks_mut::<4>().0.iter_mut())
            {
                target.copy_from_slice(&[source[2], source[1], source[0], 255]);
            }
        }
        Ok((pixels, width as u32, height as u32))
    })();
    unsafe {
        context.Unmap(&staging, 0);
    }
    result
}

/// Black out a clipped sensitive rectangle in an RGBA capture.
///
/// Args:
///     pixels: In-memory RGBA image.
///     width: Image pixel width.
///     height: Image pixel height.
///     left: Sensitive left boundary relative to capture origin.
///     top: Sensitive top boundary relative to capture origin.
///     right: Sensitive right boundary.
///     bottom: Sensitive bottom boundary.
///
/// Returns:
///     None: The selected pixels are replaced with opaque black.
fn mask_pixels(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
) {
    // Expand the mask to cover anti-aliased sensitive field edges.
    let left = (left - 2).clamp(0, i64::from(width)) as usize;
    let top = (top - 2).clamp(0, i64::from(height)) as usize;
    let right = (right + 2).clamp(0, i64::from(width)) as usize;
    let bottom = (bottom + 2).clamp(0, i64::from(height)) as usize;
    for y in top..bottom {
        for x in left..right {
            pixels[(y * width as usize + x) * 4..(y * width as usize + x + 1) * 4]
                .copy_from_slice(&[0, 0, 0, 255]);
        }
    }
}

/// Encode a metadata-free PNG in memory after sensitive masking.
///
/// Args:
///     pixels: Sanitized RGBA pixels.
///     width: Image width.
///     height: Image height.
///
/// Returns:
///     Result<Vec<u8>, BackendError>: A bounded PNG without application metadata.
fn encode_png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, BackendError> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|_| unavailable())?;
    writer.write_image_data(pixels).map_err(|_| unavailable())?;
    writer.finish().map_err(|_| unavailable())?;
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Err(BackendError::new(
            "INVALID_ARGUMENT",
            "The filtered capture exceeds its storage limit",
            false,
        ));
    }
    Ok(bytes)
}

/// Convert a native physical rectangle to common JSON fields.
///
/// Args:
///     bounds: Physical window or UIA rectangle.
///
/// Returns:
///     Value: Nonnegative width and height with physical coordinates.
fn rect_value(bounds: &RECT) -> Value {
    json!({"x":bounds.left,"y":bounds.top,"width":(bounds.right-bounds.left).max(0),"height":(bounds.bottom-bounds.top).max(0)})
}

/// Map UIA control identifiers to portable accessibility roles.
///
/// Args:
///     control: Windows UI Automation control type.
///
/// Returns:
///     &'static str: Portable role label.
fn role(control: i32) -> &'static str {
    match control {
        value if value == UIA_ButtonControlTypeId.0 => "button",
        value if value == UIA_EditControlTypeId.0 => "textbox",
        value if value == UIA_ComboBoxControlTypeId.0 => "combobox",
        value if value == UIA_DocumentControlTypeId.0 => "document",
        value if value == UIA_CheckBoxControlTypeId.0 => "checkbox",
        value if value == UIA_RadioButtonControlTypeId.0 => "radio",
        value if value == UIA_HyperlinkControlTypeId.0 => "link",
        value if value == UIA_TabControlTypeId.0 => "tablist",
        value if value == UIA_TabItemControlTypeId.0 => "tab",
        value if value == UIA_TextControlTypeId.0 => "text",
        value if value == UIA_WindowControlTypeId.0 => "window",
        value if value == UIA_ToolBarControlTypeId.0 => "toolbar",
        value if value == UIA_ListControlTypeId.0 => "list",
        value if value == UIA_ListItemControlTypeId.0 => "listitem",
        value if value == UIA_ImageControlTypeId.0 => "image",
        value if value == UIA_MenuControlTypeId.0 => "menu",
        value if value == UIA_MenuItemControlTypeId.0 => "menuitem",
        value if value == UIA_PaneControlTypeId.0 => "group",
        _ => "group",
    }
}

/// Identify sensitive labels using intrinsic defaults and trusted configuration.
///
/// Args:
///     name: Untrusted accessibility label.
///     patterns: Trusted literal label patterns.
///
/// Returns:
///     bool: Whether the complete control subtree requires privacy filtering.
fn sensitive_name(name: &str, patterns: &[String]) -> bool {
    let name = name.to_lowercase();
    let defaults = [
        "password",
        "passphrase",
        "credit card",
        "card number",
        "security code",
        "cvv",
        "secret",
        "access token",
        "api key",
    ];
    defaults.iter().any(|pattern| name.contains(pattern))
        || sensitive_card_name(&name)
        || patterns
            .iter()
            .any(|pattern| !pattern.is_empty() && name.contains(pattern))
}

/// Identify a complete ASCII Card token within a field or label name.
///
/// Args:
///     name: Accessibility label whose ASCII word boundaries retain digits and underscores.
///
/// Returns:
///     bool: Whether a case-insensitive complete Card token occurs in the label.
fn sensitive_card_name(name: &str) -> bool {
    // Match full ASCII words so unrelated Cardboard, Card2, and card_name labels remain public.
    name.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .any(|word| word.eq_ignore_ascii_case("card"))
}

/// Apply default sensitive hints to field and label roles and trusted patterns to configured subtrees.
///
/// Args:
///     control: UIA control type identifier.
///     name: Untrusted accessibility control name.
///     patterns: Trusted literal subtree mask patterns.
///
/// Returns:
///     bool: Whether this node and its descendants require privacy filtering.
fn sensitive_control(control: i32, name: &str, patterns: &[String]) -> bool {
    let field_or_label = [
        UIA_EditControlTypeId,
        UIA_ComboBoxControlTypeId,
        UIA_TextControlTypeId,
        UIA_ButtonControlTypeId,
        UIA_CheckBoxControlTypeId,
        UIA_RadioButtonControlTypeId,
        UIA_HyperlinkControlTypeId,
    ]
    .iter()
    .any(|kind| kind.0 == control);
    // Browser and document titles remain observable under the default field privacy hints.
    (field_or_label && sensitive_name(name, &[]))
        || patterns
            .iter()
            .any(|pattern| !pattern.is_empty() && name.to_lowercase().contains(pattern))
}

/// Identify supported localized browser omnibox accessibility labels.
///
/// Args:
///     name: Browser toolbar edit label.
///
/// Returns:
///     bool: Whether the label identifies the Chrome address field.
fn address_name(name: &str) -> bool {
    let name = name.to_lowercase();
    name.contains("address and search bar")
        || name.contains("address bar")
        || name.contains("\u{5730}\u{5740}\u{680f}")
        || name.contains("\u{5730}\u{5740}\u{548c}\u{641c}\u{7d22}")
}

/// Retain a fully specified address from the browser's read-only omnibox value.
///
/// Args:
///     value: Current browser address field value.
///
/// Returns:
///     Result<String, BackendError>: Verified address suitable for core origin policy.
fn verified_url(value: &str) -> Result<String, BackendError> {
    let value = value.trim();
    if value.len() > 8192
        || !(value.starts_with("http://")
            || value.starts_with("https://")
            || value == "about:blank"
            || value.starts_with("chrome://"))
    {
        return Err(BackendError::new(
            "POLICY_DENIED",
            "The browser address is incomplete or outside supported schemes",
            false,
        ));
    }
    Ok(value.to_owned())
}

/// Resolve committed document metadata with an inactive-omnibox fallback.
///
/// Args:
///     observation: Private browser-chrome URL discovery result.
///
/// Returns:
///     Result<String, BackendError>: Authoritative current address or policy failure.
fn observation_url(observation: &Observation) -> Result<String, BackendError> {
    // Editable omnibox values authorize only the explicit initial blank state.
    observation
        .document_url
        .as_ref()
        .or_else(|| {
            observation
                .url
                .as_ref()
                .filter(|url| !observation.address_focused || url.as_str() == "about:blank")
        })
        .cloned()
        .ok_or_else(|| {
            BackendError::new(
                "POLICY_DENIED",
                "The current browser address cannot be verified",
                false,
            )
        })
}

/// Read a provider-owned document URL through available read-only value patterns.
///
/// Args:
///     element: Verified top-level Chrome RootWebArea accessibility element.
///
/// Returns:
///     Option<String>: A fully specified current document URL when exposed by UIA.
fn document_url(element: &IUIAutomationElement) -> Option<String> {
    // Native UIA document providers and the UIA MSAA bridge expose different patterns.
    if let Ok(pattern) =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        && let Ok(value) = unsafe { pattern.CurrentValue() }
        && let Ok(url) = verified_url(&value.to_string())
    {
        return Some(url);
    }
    // The legacy provider reads the document's accessibility tree URL without invoking it.
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
            UIA_LegacyIAccessiblePatternId,
        )
    } && let Ok(value) = unsafe { pattern.CurrentValue() }
        && let Ok(url) = verified_url(&value.to_string())
    {
        return Some(url);
    }
    None
}

/// Distinguish an empty UIA relationship from a failed accessibility provider read.
///
/// Args:
///     walker: Owned read-only UIA tree walker.
///     element: Current browser or owned selector element.
///     first_child: Whether to read its first child or its next sibling.
///
/// Returns:
///     Result<Option<IUIAutomationElement>, BackendError>: A child, normal leaf, or failure.
fn walker_element(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    first_child: bool,
) -> Result<Option<IUIAutomationElement>, BackendError> {
    let mut result = std::ptr::null_mut();
    // Read the COM HRESULT separately from its nullable relationship interface.
    let status = unsafe {
        let table = Interface::vtable(walker);
        if first_child {
            (table.GetFirstChildElement)(
                Interface::as_raw(walker),
                Interface::as_raw(element),
                &mut result,
            )
        } else {
            (table.GetNextSiblingElement)(
                Interface::as_raw(walker),
                Interface::as_raw(element),
                &mut result,
            )
        }
    };
    status.ok().map_err(|_| stale())?;
    // Successful null results represent leaves; every provider HRESULT failure is propagated.
    if result.is_null() {
        Ok(None)
    } else {
        // Take ownership of the reference returned by the successful UIA relationship call.
        Ok(Some(unsafe { IUIAutomationElement::from_raw(result) }))
    }
}

/// Read a required nonempty string parameter without exposing it in failures.
///
/// Args:
///     params: Request parameter object.
///     name: Required field name.
///
/// Returns:
///     Result<&str, BackendError>: The validated string field.
fn required_string<'a>(params: &'a Value, name: &str) -> Result<&'a str, BackendError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(invalid)
}

/// Read a required unsigned 32-bit parameter with checked conversion.
///
/// Args:
///     params: Request parameter object.
///     name: Required field name.
///
/// Returns:
///     Result<u32, BackendError>: The validated integer field.
fn required_u32(params: &Value, name: &str) -> Result<u32, BackendError> {
    params
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(invalid)
}

/// Read a required signed physical coordinate with checked conversion.
///
/// Args:
///     params: Request parameter object.
///     name: Required field name.
///
/// Returns:
///     Result<i32, BackendError>: The validated integer coordinate.
fn required_i32(params: &Value, name: &str) -> Result<i32, BackendError> {
    params
        .get(name)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(invalid)
}

/// Construct a safe invalid desktop parameter failure.
///
/// Args:
///     None: The message is fixed.
///
/// Returns:
///     BackendError: Stable invalid argument failure.
fn invalid() -> BackendError {
    BackendError::new(
        "INVALID_ARGUMENT",
        "The desktop request parameters are invalid",
        false,
    )
}

/// Construct a safe unavailable native backend failure.
///
/// Args:
///     None: The message is fixed.
///
/// Returns:
///     BackendError: Stable input backend failure.
fn unavailable() -> BackendError {
    BackendError::new(
        "INPUT_BACKEND_UNAVAILABLE",
        "The required Windows desktop API is unavailable",
        true,
    )
}

/// Construct a safe disconnected browser failure.
///
/// Args:
///     None: The message is fixed.
///
/// Returns:
///     BackendError: Stable browser disconnected failure.
fn disconnected() -> BackendError {
    BackendError::new(
        "BROWSER_DISCONNECTED",
        "The bound browser window or process is unavailable",
        false,
    )
}

/// Construct a safe stale accessibility target failure.
///
/// Args:
///     None: The message is fixed.
///
/// Returns:
///     BackendError: Stable stale target failure.
fn stale() -> BackendError {
    BackendError::new(
        "TARGET_STALE",
        "The accessibility target or image is stale",
        true,
    )
}

/// Construct a safe foreground ownership failure.
///
/// Args:
///     None: The message is fixed.
///
/// Returns:
///     BackendError: Stable focus lost failure.
fn focus_lost() -> BackendError {
    BackendError::new(
        "FOCUS_LOST",
        "The bound browser window is not foreground",
        true,
    )
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    /// Verify Card field labels receive protection while browser titles retain default visibility.
    ///
    /// Args:
    ///     None: The test uses synthetic labels and native control type identifiers.
    ///
    /// Returns:
    ///     None: Complete token, role restriction, and custom-pattern assertions pass.
    #[test]
    fn card_field_privacy_uses_complete_ascii_tokens_and_preserves_titles() {
        // Cover casing, punctuation, and full payment-field names at the privacy classification boundary.
        for name in [
            "Card",
            "CARD",
            "Card number",
            "Payment card",
            "Card / expiry",
        ] {
            assert!(sensitive_control(UIA_EditControlTypeId.0, name, &[]));
            assert!(sensitive_control(UIA_TextControlTypeId.0, name, &[]));
        }
        // Retain unrelated labels whose ASCII token continues with letters, digits, or underscores.
        for name in ["Cardboard", "Cardiology", "Discard", "Card2", "card_name"] {
            assert!(!sensitive_control(UIA_EditControlTypeId.0, name, &[]));
        }
        assert!(!sensitive_control(
            UIA_WindowControlTypeId.0,
            "Payment Card",
            &[]
        ));
        assert!(!sensitive_control(
            UIA_DocumentControlTypeId.0,
            "Card number",
            &[]
        ));
        // Trusted literal configuration continues to protect configured document subtrees.
        assert!(sensitive_control(
            UIA_DocumentControlTypeId.0,
            "Payment Card",
            &["payment".to_owned()]
        ));
    }

    /// Verify encoded captures contain only sanitized pixels at protected boundaries.
    ///
    /// Args:
    ///     None: The test uses synthetic RGBA pixels in memory.
    ///
    /// Returns:
    ///     None: PNG decoding confirms masking and preservation outside the field.
    #[test]
    fn protected_capture_pixels_are_masked_before_png_encoding() {
        let mut pixels = [170_u8, 30, 80, 255].repeat(20 * 20);
        // Protect an area touching the capture origin and expand its edge coverage.
        mask_pixels(&mut pixels, 20, 20, -2, -2, 6, 6);
        let encoded = encode_png(&pixels, 20, 20).expect("encode fixture pixels");
        let mut reader = png::Decoder::new(Cursor::new(encoded))
            .read_info()
            .expect("read PNG header");
        let mut decoded = vec![0_u8; reader.output_buffer_size().expect("bounded decoded image")];
        reader
            .next_frame(&mut decoded)
            .expect("decode sanitized PNG");
        // Verify the mask's expanded boundary and an unaffected distant image region.
        assert_eq!(
            &decoded[(7 * 20 + 7) * 4..(7 * 20 + 8) * 4],
            &[0, 0, 0, 255]
        );
        assert_eq!(
            &decoded[(8 * 20 + 8) * 4..(8 * 20 + 9) * 4],
            &[170, 30, 80, 255]
        );
        assert_eq!(&decoded[..4], &[0, 0, 0, 255]);
    }

    /// Verify Unicode strategy produces paired UTF-16 packets for supplementary text.
    ///
    /// Args:
    ///     None: The test constructs input records without injecting them.
    ///
    /// Returns:
    ///     None: Both surrogate units have a matching key release.
    #[test]
    fn unicode_submission_preserves_surrogate_pairs_and_releases() {
        let packets = unicode_keys('\u{1f642}');
        assert_eq!(packets.len(), 4);
        // Inspect native records without sending any OS input.
        unsafe {
            assert_eq!(packets[0].Anonymous.ki.wScan, 0xd83d);
            assert_eq!(packets[1].Anonymous.ki.wScan, 0xd83d);
            assert_eq!(packets[2].Anonymous.ki.wScan, 0xde42);
            assert_eq!(packets[3].Anonymous.ki.wScan, 0xde42);
            assert_eq!(packets[0].Anonymous.ki.dwFlags, KEYEVENTF_UNICODE);
            assert_eq!(
                packets[1].Anonymous.ki.dwFlags,
                KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            );
        }
    }

    /// Require complete browser schemes before an address can authorize an action.
    ///
    /// Args:
    ///     None: The test uses owned local and deliberately incomplete addresses.
    ///
    /// Returns:
    ///     None: Ambiguous omnibox values remain policy failures.
    #[test]
    fn incomplete_omnibox_addresses_cannot_authorize_origins() {
        assert_eq!(
            verified_url("http://127.0.0.1:12345/fixture").expect("complete URL"),
            "http://127.0.0.1:12345/fixture"
        );
        assert!(verified_url("127.0.0.1:12345/fixture").is_err());
        assert!(verified_url("example.test/path").is_err());
        assert!(verified_url("file:///fixture").is_err());
    }
}
