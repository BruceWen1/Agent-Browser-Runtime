// -*- coding: utf-8 -*-
// observer.cc
// Chromium browser-owned read-only observer
// =====================
// Read scoped browser, tab, accessibility, and viewport state on the browser UI thread.

#include "chrome/browser/abr_native_observer/observer.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <initializer_list>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/threading/thread.h"
#include "base/values.h"
#include "build/build_config.h"
#include "chrome/browser/abr_native_observer/observer_transport.h"
#include "chrome/browser/abr_native_observer/privacy_policy.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/chrome_paths.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/sessions/core/session_id.h"
#include "components/version_info/version_info.h"
#include "components/zoom/zoom_controller.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "ui/accessibility/ax_enums.mojom.h"
#include "ui/accessibility/ax_node_data.h"
#include "ui/accessibility/ax_tree.h"
#include "ui/accessibility/platform/browser_accessibility.h"
#include "ui/accessibility/platform/browser_accessibility_manager.h"
#include "ui/base/base_window.h"
#include "ui/gfx/geometry/rect.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#endif

namespace abr {
namespace {

// Bound cached AX reads and public strings independently from the wire limit.
constexpr int kMaximumNodes = 6000;
constexpr int kMaximumDepth = 32;
constexpr char kBrowserCommit[] = "634b046faf2137b83af71c87baf362b533af9104";

// Build a closed success response for one authenticated request.
// Args:
//   identifier: Correlation identifier copied from validated framing.
//   value: Filtered browser-thread observation result.
// Returns:
//   base::Value: A versioned IPC response.
base::Value Success(const std::string& identifier, base::Value value) {
  base::DictValue result;
  result.Set("schemaVersion", 1);
  result.Set("requestId", identifier);
  result.Set("ok", true);
  result.Set("result", std::move(value));
  return base::Value(std::move(result));
}

// Truncate renderer-controlled UTF-8 text through a safe Unicode conversion.
// Args:
//   value: Renderer accessibility text.
//   maximum: Maximum UTF-16 code-unit count.
// Returns:
//   string: Bounded valid UTF-8 observation text.
std::string PublicText(const std::string& value, size_t maximum) {
  auto decoded = base::UTF8ToUTF16(value);
  decoded.resize(std::min(decoded.size(), maximum));
  return base::UTF16ToUTF8(decoded);
}

// Represent measured coordinates in a portable observation object.
// Args:
//   rectangle: Physical screen coordinates or explicitly labelled DIP geometry.
// Returns:
//   DictValue: Nonnegative rectangle dimensions.
base::DictValue Rectangle(const gfx::Rect& rectangle) {
  base::DictValue value;
  value.Set("x", rectangle.x());
  value.Set("y", rectangle.y());
  value.Set("width", std::max(0, rectangle.width()));
  value.Set("height", std::max(0, rectangle.height()));
  return value;
}

// Map cached Chromium roles to common runtime accessibility labels.
// Args:
//   role: Chromium accessibility role.
// Returns:
//   const char*: A portable role label.
const char* Role(ax::mojom::Role role) {
  // Keep the portable set explicit and preserve generic composite containers.
  switch (role) {
    case ax::mojom::Role::kRootWebArea: return "document";
    case ax::mojom::Role::kButton: return "button";
    case ax::mojom::Role::kTextField: return "textbox";
    case ax::mojom::Role::kTextFieldWithComboBox: return "combobox";
    case ax::mojom::Role::kCheckBox: return "checkbox";
    case ax::mojom::Role::kRadioButton: return "radio";
    case ax::mojom::Role::kLink: return "link";
    case ax::mojom::Role::kTab: return "tab";
    case ax::mojom::Role::kTabList: return "tablist";
    case ax::mojom::Role::kStaticText: return "text";
    case ax::mojom::Role::kHeading: return "heading";
    case ax::mojom::Role::kList: return "list";
    case ax::mojom::Role::kListItem: return "listitem";
    case ax::mojom::Role::kMenu: return "menu";
    case ax::mojom::Role::kMenuItem: return "menuitem";
    case ax::mojom::Role::kImage: return "image";
    case ax::mojom::Role::kDialog: return "dialog";
    default: return "group";
  }
}

// Assign a stable browser-window identifier without exposing object addresses.
// Args:
//   browser: Browser window authorized for the isolated profile.
// Returns:
//   string: Session-backed browser window identifier.
std::string WindowId(BrowserWindowInterface* browser) {
  return "browser-" + base::NumberToString(browser->GetSessionID().id());
}

// Assign a stable tab identifier from the upstream session helper.
// Args:
//   contents: Authorized WebContents within the scoped browser.
// Returns:
//   string: Stable tab identifier.
std::string TabId(content::WebContents* contents) {
  return "tab-" + base::NumberToString(sessions::SessionTabHelper::IdForTab(contents).id());
}

// Read the current native HWND for a Windows browser window.
// Args:
//   browser: Browser window authorized for the isolated profile.
// Returns:
//   optional<string>: An OS window identifier when a native mapping is verified.
std::optional<std::string> OsWindowId(BrowserWindowInterface* browser) {
#if BUILDFLAG(IS_WIN)
  const auto native = browser->GetWindow()->GetNativeWindow();
  // Window hosts can be absent during browser teardown.
  if (!native || !native->GetHost()) { return std::nullopt; }
  HWND handle = native->GetHost()->GetAcceleratedWidget();
  DWORD process = 0;
  GetWindowThreadProcessId(handle, &process);
  // The observer exposes only current-browser-process HWND mappings.
  if (!IsWindow(handle) || process != GetCurrentProcessId()) { return std::nullopt; }
  return "hwnd-" + base::StringPrintf("%llx", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(handle)));
#else
  // Platform mappings require a separately validated native-window adapter.
  return std::nullopt;
#endif
}

// Resolve the current main frame's browser-owned accessibility cache.
// Args:
//   contents: WebContents selected from an authorized tab strip.
// Returns:
//   BrowserAccessibility*: The cached document root or unavailable state.
ui::BrowserAccessibility* AccessibilityRoot(content::WebContents* contents) {
  auto* frame = contents->GetPrimaryMainFrame();
  if (!frame) { return nullptr; }
  auto* manager = ui::BrowserAccessibilityManager::FromID(frame->GetAXTreeID());
  return manager ? manager->GetBrowserAccessibilityRoot() : nullptr;
}

// Identify cached roles eligible for independent Card field-name protection.
// Args:
//   role: Renderer-cached accessibility role.
// Returns:
//   bool: Whether the role represents an input or a field label.
bool CardFieldOrLabel(ax::mojom::Role role) {
  // Restrict the added Card rule to controls and text labels rather than document containers.
  switch (role) {
    case ax::mojom::Role::kTextField:
    case ax::mojom::Role::kTextFieldWithComboBox:
    case ax::mojom::Role::kComboBoxGrouping:
    case ax::mojom::Role::kComboBoxSelect:
    case ax::mojom::Role::kSpinButton:
    case ax::mojom::Role::kCheckBox:
    case ax::mojom::Role::kRadioButton:
    case ax::mojom::Role::kSwitch:
    case ax::mojom::Role::kLabelText:
    case ax::mojom::Role::kStaticText:
    case ax::mojom::Role::kInlineTextBox:
      return true;
    default:
      return false;
  }
}

// Validate every sensitive pattern before resolving browser or accessibility objects.
// Args:
//   patterns: Optional authenticated literal pattern list.
// Returns:
//   bool: Whether all complete pattern strings satisfy the fixed protocol limits.
bool ValidPatterns(const base::ListValue* patterns) {
  // An absent list selects the built-in privacy rules.
  if (!patterns) { return true; }
  if (patterns->size() > 64) { return false; }
  // Reject malformed elements as a whole request rather than selecting a partial policy.
  for (const auto& pattern : *patterns) {
    if (!pattern.is_string() || !privacy::ValidSensitivePattern(pattern.GetString())) {
      return false;
    }
  }
  return true;
}

// Identify protected cached nodes before reading names, values, or children.
// Args:
//   data: Browser-owned accessibility node data.
//   patterns: Trusted sensitive-name pattern configuration.
// Returns:
//   bool: Whether the whole node subtree requires privacy filtering.
bool Protected(const ui::AXNodeData& data, const base::ListValue* patterns) {
  // Intrinsic password state protects values independently of localized labels.
  if (data.HasState(ax::mojom::State::kProtected) || data.IsPasswordField()) { return true; }
  // Existing HTML cache metadata strengthens filtering while retaining the selected AX mode.
  for (const auto& attribute : data.html_attributes) {
    if (privacy::AsciiEqual(attribute.first, "data-sensitive") ||
        (privacy::AsciiEqual(attribute.first, "autocomplete") &&
         privacy::SensitiveAutocomplete(attribute.second))) {
      return true;
    }
  }
  const auto name = base::ToLowerASCII(data.GetStringAttribute(ax::mojom::StringAttribute::kName));
  if (privacy::SensitiveCardName(name, CardFieldOrLabel(data.role))) { return true; }
  constexpr const char* defaults[] = {"password", "passphrase", "credit card", "card number", "security code", "cvv", "secret", "access token", "api key"};
  // Apply bounded literal matching to names and trusted configuration.
  for (const char* pattern : defaults) { if (name.find(pattern) != std::string::npos) { return true; } }
  if (patterns) {
    for (const auto& pattern : *patterns) {
      if (name.find(base::ToLowerASCII(pattern.GetString())) != std::string::npos) { return true; }
    }
  }
  return false;
}

// Validate a closed observation parameter set before choosing any default.
// Args:
//   params: Renderer-independent authenticated request parameters.
//   names: Complete accepted parameter field names.
// Returns:
//   bool: Whether every field belongs to the declared method shape.
bool Fields(const base::DictValue& params, std::initializer_list<std::string_view> names) {
  // Reject unexpected fields without including their names or values in diagnostics.
  for (auto entry : params) {
    if (std::find(names.begin(), names.end(), entry.first) == names.end()) { return false; }
  }
  return true;
}

// Read a bounded cached node tree with exact upstream physical-screen geometry.
// Args:
//   node: Browser-owned cached accessibility node.
//   depth: Current recursion level.
//   maximum_depth: Trusted bounded depth limit.
//   remaining: Remaining node budget.
//   seen: Complete tree-and-node identity set for cycle rejection.
//   patterns: Trusted literal sensitive name patterns.
// Returns:
//   optional<Value>: A privacy-filtered node or incomplete-read failure.
std::optional<base::Value> Node(ui::BrowserAccessibility* node, int depth,
                               int maximum_depth, int* remaining,
                               std::set<std::string>* seen,
                               const base::ListValue* patterns) {
  // An incomplete bounded tree remains unavailable rather than becoming actionable.
  if (!node || depth > maximum_depth || *remaining <= 0) { return std::nullopt; }
  --*remaining;
  const auto& data = node->GetData();
  const std::string identifier = node->manager()->ax_tree()->data().tree_id.ToString() + ":" + base::NumberToString(data.id);
  if (!seen->insert(identifier).second) { return std::nullopt; }
  ui::AXOffscreenResult offscreen = ui::AXOffscreenResult::kOnscreen;
  const gfx::Rect bounds = node->GetBoundsRect(ui::AXCoordinateSystem::kScreenPhysicalPixels, ui::AXClippingBehavior::kClipped, &offscreen);
  const bool protected_node = Protected(data, patterns);
  base::ListValue states;
  if (protected_node) { states.Append("protected"); }
  if (offscreen == ui::AXOffscreenResult::kOffscreen) { states.Append("offscreen"); }
  if (data.GetIntAttribute(ax::mojom::IntAttribute::kRestriction) == static_cast<int>(ax::mojom::Restriction::kDisabled)) { states.Append("disabled"); }
  if (node->IsFocused()) { states.Append("focused"); }
  auto rectangle = Rectangle(bounds);
  rectangle.Set("space", "screen-physical");
  base::DictValue result;
  result.Set("nodeId", identifier);
  result.Set("role", Role(data.role));
  result.Set("states", std::move(states));
  result.Set("bounds", std::move(rectangle));
  // Protected controls stop recursion before any readable value reaches the wire.
  if (protected_node) { return base::Value(std::move(result)); }
  result.Set("name", PublicText(data.GetStringAttribute(ax::mojom::StringAttribute::kName), 1024));
  if (data.HasStringAttribute(ax::mojom::StringAttribute::kValue)) {
    result.Set("value", PublicText(data.GetStringAttribute(ax::mojom::StringAttribute::kValue), 2048));
  }
  base::ListValue children;
  // Platform children include browser-cache cross-frame accessibility descendants.
  for (size_t index = 0; index < node->PlatformChildCount(); ++index) {
    auto child = Node(node->PlatformGetChild(index), depth + 1, maximum_depth, remaining, seen, patterns);
    if (!child) { return std::nullopt; }
    children.Append(std::move(*child));
  }
  if (!children.empty()) { result.Set("children", std::move(children)); }
  return base::Value(std::move(result));
}

// Read viewport metrics using cached AX screen coordinates and upstream zoom APIs.
// Args:
//   browser: Scoped browser window.
//   contents: Scoped active or selected tab.
// Returns:
//   optional<DictValue>: Verified geometry when the view and native window exist.
std::optional<base::DictValue> Metrics(BrowserWindowInterface* browser, content::WebContents* contents) {
  auto* view = contents->GetRenderWidgetHostView();
  auto* root = AccessibilityRoot(contents);
  if (!view || !root) { return std::nullopt; }
  const double zoom = blink::ZoomLevelToZoomFactor(zoom::ZoomController::GetZoomLevelForWebContents(contents));
  const double scale = view->GetDeviceScaleFactor();
  if (zoom <= 0 || scale <= 0) { return std::nullopt; }
  const auto viewport = root->GetBoundsRect(ui::AXCoordinateSystem::kScreenPhysicalPixels, ui::AXClippingBehavior::kClipped);
  gfx::Rect window = browser->GetWindow()->GetBounds();
  bool verified = false;
#if BUILDFLAG(IS_WIN)
  const auto native = browser->GetWindow()->GetNativeWindow();
  RECT physical = {};
  // Exact HWND geometry supports physical-screen and CSS transforms on Windows.
  if (!native || !native->GetHost() || !GetWindowRect(native->GetHost()->GetAcceleratedWidget(), &physical)) { return std::nullopt; }
  window = gfx::Rect(physical.left, physical.top, physical.right - physical.left, physical.bottom - physical.top);
  verified = true;
#endif
  base::DictValue geometry;
  geometry.Set("windowOrigin", base::DictValue().Set("x", window.x()).Set("y", window.y()));
  geometry.Set("viewportOrigin", base::DictValue().Set("x", viewport.x()).Set("y", viewport.y()));
  geometry.Set("monitorScale", scale);
  geometry.Set("viewportMetricsVerified", verified);
  base::DictValue result;
  result.Set("geometry", std::move(geometry));
  result.Set("scale", base::DictValue().Set("dpr", scale * zoom).Set("zoom", zoom));
  result.Set("windowBounds", Rectangle(window));
  result.Set("viewportBounds", Rectangle(viewport));
  result.Set("nativeWindowMappingVerified", verified);
  return result;
}

// Reply
// Carry one bounded worker-to-UI reply without accessing browser objects off-thread.
struct Reply {
  std::mutex mutex;
  std::condition_variable ready;
  bool completed = false;
  std::optional<base::Value> result;
};

// ObserverRuntime
// Own the scoped read-only UI service and its private blocking transport thread.
class ObserverRuntime {
 public:
  // Create an initially stopped runtime with a dedicated observation worker.
  // Args:
  //   None: The Chromium startup hook supplies launch scope later.
  // Returns:
  //   ObserverRuntime: An inactive runtime.
  ObserverRuntime() : worker_("ABRReadOnlyObserver") {}
  // Start the opt-in observer with the browser's canonical data directory.
  // Args:
  //   None: Chromium's browser command line selects the launch scope.
  // Returns:
  //   None: A dedicated thread validates its inherited private bootstrap.
  void Start() {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    // Start only in the browser process with an explicitly selected isolated profile.
    if (!base::CommandLine::ForCurrentProcess()->HasSwitch("abr-observer") ||
        !base::CommandLine::ForCurrentProcess()->HasSwitch("user-data-dir") ||
        !base::PathService::Get(chrome::DIR_USER_DATA, &user_directory_) || !user_directory_.IsAbsolute()) { return; }
    ui_runner_ = base::SingleThreadTaskRunner::GetCurrentDefault();
    if (!worker_.Start()) { return; }
    stopped_.store(false, std::memory_order_release);
    worker_.task_runner()->PostTask(FROM_HERE, base::BindOnce(&ServeObserver, user_directory_, &stopped_, base::BindRepeating(&ObserverRuntime::Dispatch, base::Unretained(this))));
  }
  // Cancel private IO and join the worker before browser state teardown.
  // Args:
  //   None: The browser shutdown hook owns the lifecycle.
  // Returns:
  //   None: Pending transport and reply waits finish.
  void Stop() {
    stopped_.store(true, std::memory_order_release);
    worker_.Stop();
  }
 private:
  // Verify a browser belongs to the isolated authorized profile directory.
  // Args:
  //   browser: Enumerated browser UI object.
  // Returns:
  //   bool: Whether the browser is in the authorized persistent scope.
  bool Authorized(BrowserWindowInterface* browser) const {
    auto* profile = browser->GetProfile();
    return !profile->IsOffTheRecord() && profile->GetPath().DirName() == user_directory_;
  }
  // Marshal one authenticated request to the browser UI thread.
  // Args:
  //   bootstrap: Authenticated launch metadata.
  //   request: Closed protocol request.
  // Returns:
  //   Value: A UI result or fixed timeout/disconnected error.
  base::Value Dispatch(const Bootstrap& bootstrap, base::DictValue request) {
    const std::string identifier = *request.FindString("requestId");
    auto reply = std::make_shared<Reply>();
    if (!ui_runner_->PostTask(FROM_HERE, base::BindOnce(&ObserverRuntime::RunOnUI, base::Unretained(this), bootstrap.profile_id, std::move(request), reply))) {
      return ObserverFailure(identifier, "BROWSER_DISCONNECTED", "Browser observation thread is unavailable");
    }
    std::unique_lock<std::mutex> lock(reply->mutex);
    const auto started = std::chrono::steady_clock::now();
    // Keep shutdown responsive while a busy UI thread delays a read-only request.
    while (!reply->completed && !stopped_.load(std::memory_order_acquire) &&
           std::chrono::steady_clock::now() - started < std::chrono::seconds(5)) {
      reply->ready.wait_for(lock, std::chrono::milliseconds(25));
    }
    if (!reply->completed || !reply->result) { return ObserverFailure(identifier, "TIMEOUT", "Browser observation exceeded its deadline"); }
    return std::move(*reply->result);
  }
  // Resolve one request exclusively on the browser UI thread.
  // Args:
  //   profile_id: Profile identity from the validated ownership marker.
  //   request: Closed authenticated request.
  //   reply: Shared completion state owned by the worker and UI task.
  // Returns:
  //   None: The worker receives a safe value through its condition variable.
  void RunOnUI(std::string profile_id, base::DictValue request, std::shared_ptr<Reply> reply) {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    const std::string identifier = *request.FindString("requestId");
    auto response = stopped_.load(std::memory_order_acquire)
        ? ObserverFailure(identifier, "BROWSER_DISCONNECTED", "Browser observer is stopping")
        : Read(profile_id, request);
    // Publish the value before waking the worker; no browser objects cross threads.
    { std::lock_guard<std::mutex> lock(reply->mutex); reply->result = std::move(response); reply->completed = true; }
    reply->ready.notify_one();
  }
  // Read the closed observation method set from scoped browser objects.
  // Args:
  //   profile_id: Authorized profile marker identity.
  //   request: Authenticated method and parameter object.
  // Returns:
  //   Value: Read-only method result or a fixed runtime failure.
  base::Value Read(const std::string& profile_id, const base::DictValue& request) {
    const auto& identifier = *request.FindString("requestId");
    const auto& method = *request.FindString("method");
    const auto& params = *request.FindDict("params");
    // Hello and state expose only version and capability metadata.
    if (method == "observer.hello" || method == "observer.getState") {
      if (method == "observer.getState" && !params.empty()) { return ObserverFailure(identifier, "INVALID_ARGUMENT", "Observer state parameters are invalid"); }
      base::DictValue state;
      state.Set("schemaVersion", 1);
      state.Set("protocolVersion", 1);
      state.Set("authVersion", 2);
      state.Set("observerVersion", "0.1.0");
      state.Set("browserVersion", version_info::GetVersionNumber());
      state.Set("browserCommit", kBrowserCommit);
      state.Set("profileId", profile_id);
      state.Set("featureFlags", base::DictValue().Set("readOnlyObserver", true).Set("osInput", false));
      state.Set("subscriptions", false);
      return Success(identifier, base::Value(std::move(state)));
    }
    const int limit = params.FindInt("limit").value_or(kMaximumNodes);
    const int depth = params.FindInt("treeDepth").value_or(kMaximumDepth);
    const auto* patterns = params.FindList("sensitivePatterns");
    // Reject complete malformed privacy policies before enumerating or reading browser state.
    if (method == "observer.readAccessibility" &&
        (!Fields(params, {"tabId", "limit", "treeDepth", "sensitivePatterns"}) ||
         (params.contains("limit") && !params.FindInt("limit")) ||
         (params.contains("treeDepth") && !params.FindInt("treeDepth")) ||
         (params.contains("sensitivePatterns") && !patterns) ||
         !params.FindString("tabId") || limit <= 0 || limit > kMaximumNodes ||
         depth <= 0 || depth > kMaximumDepth || !ValidPatterns(patterns))) {
      return ObserverFailure(identifier, "INVALID_ARGUMENT", "Accessibility observation parameters are invalid");
    }
    // Resolve browser and tab identities only through the scoped global collection.
    BrowserWindowInterface* selected_browser = nullptr;
    content::WebContents* selected_tab = nullptr;
    base::ListValue windows;
    GlobalBrowserCollection::GetInstance()->ForEach([&](BrowserWindowInterface* browser) {
      if (!Authorized(browser)) { return true; }
      if (method == "observer.listWindows") {
        base::DictValue window;
        window.Set("windowId", WindowId(browser));
        window.Set("active", browser->IsActive());
        window.Set("bounds", Rectangle(browser->GetWindow()->GetBounds()));
        window.Set("boundsSpace", "screen-dip");
        auto native = OsWindowId(browser);
        if (native) { window.Set("osWindowId", *native); }
        windows.Append(std::move(window));
      }
      const auto* window_id = params.FindString("windowId");
      if (window_id && *window_id == WindowId(browser)) { selected_browser = browser; }
      const auto* tab_id = params.FindString("tabId");
      if (tab_id) {
        auto* tabs = browser->GetTabStripModel();
        for (int index = 0; index < tabs->count(); ++index) {
          auto* tab = tabs->GetWebContentsAt(index);
          if (*tab_id == TabId(tab)) { selected_browser = browser; selected_tab = tab; }
        }
      }
      return windows.size() < 64;
    });
    if (method == "observer.listWindows") {
      if (!params.empty()) { return ObserverFailure(identifier, "INVALID_ARGUMENT", "Window enumeration parameters are invalid"); }
      return Success(identifier, base::Value(std::move(windows)));
    }
    if (method == "observer.listTabs") {
      if (params.size() != 1 || !params.FindString("windowId")) { return ObserverFailure(identifier, "INVALID_ARGUMENT", "Tab enumeration parameters are invalid"); }
      if (!selected_browser) { return ObserverFailure(identifier, "TARGET_NOT_FOUND", "The authorized browser window is unavailable"); }
      base::ListValue result;
      auto* tabs = selected_browser->GetTabStripModel();
      for (int index = 0; index < tabs->count(); ++index) {
        auto* tab = tabs->GetWebContentsAt(index);
        base::DictValue item;
        item.Set("id", TabId(tab));
        item.Set("title", PublicText(base::UTF16ToUTF8(tab->GetTitle()), 2048));
        item.Set("url", tab->GetLastCommittedURL().spec());
        item.Set("active", tab == tabs->GetActiveWebContents());
        result.Append(std::move(item));
      }
      return Success(identifier, base::Value(std::move(result)));
    }
    // Every remaining supported read names a currently authorized tab.
    if (method != "observer.readAccessibility" && method != "observer.getViewportMetrics") {
      return ObserverFailure(identifier, "UNSUPPORTED_CAPABILITY", "The native observer method is unavailable");
    }
    if (!selected_browser || !selected_tab) { return ObserverFailure(identifier, "TARGET_NOT_FOUND", "The authorized browser tab is unavailable"); }
    auto metrics = Metrics(selected_browser, selected_tab);
    if (!metrics) { return ObserverFailure(identifier, "UNSUPPORTED_CAPABILITY", "Browser accessibility and viewport metrics are unavailable"); }
    if (method == "observer.getViewportMetrics") {
      if (params.size() != 1 || !params.FindString("tabId")) { return ObserverFailure(identifier, "INVALID_ARGUMENT", "Viewport parameters are invalid"); }
      return Success(identifier, base::Value(std::move(*metrics)));
    }
    int remaining = limit;
    std::set<std::string> seen;
    auto root = Node(AccessibilityRoot(selected_tab), 0, depth, &remaining, &seen, patterns);
    if (!root) { return ObserverFailure(identifier, "TIMEOUT", "The complete accessibility observation exceeded its limits"); }
    metrics->Set("windowId", WindowId(selected_browser));
    auto native = OsWindowId(selected_browser);
    if (native) { metrics->Set("osWindowId", *native); }
    metrics->Set("tabId", TabId(selected_tab));
    metrics->Set("url", selected_tab->GetLastCommittedURL().spec());
    metrics->Set("root", std::move(*root));
    metrics->Set("source", "chromium-accessibility");
    return Success(identifier, base::Value(std::move(*metrics)));
  }
  base::Thread worker_;
  std::atomic<bool> stopped_{true};
  base::FilePath user_directory_;
  scoped_refptr<base::SingleThreadTaskRunner> ui_runner_;
};

// Return the browser-process-owned observer runtime.
// Args:
//   None: The runtime lives for the browser process and has explicit shutdown.
// Returns:
//   ObserverRuntime&: The single scoped observation service.
ObserverRuntime& Runtime() {
  static base::NoDestructor<ObserverRuntime> runtime;
  return *runtime;
}

}  // namespace

void StartNativeObserver() { Runtime().Start(); }
void StopNativeObserver() { Runtime().Stop(); }

}  // namespace abr
