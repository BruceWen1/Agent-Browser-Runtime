// -*- coding: utf-8 -*-
// observer_transport.cc
// Native observer private IPC transport
// =====================
// Authenticate an inherited bootstrap and enforce bounded current-user framing.

#include "chrome/browser/abr_native_observer/observer_transport.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <optional>
#include <string_view>
#include <thread>
#include <vector>

#include "base/files/file_util.h"
#include "base/containers/span.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "build/build_config.h"
#include "chrome/browser/abr_native_observer/auth_policy.h"
#include "components/version_info/version_info.h"
#include "crypto/hmac.h"
#include "crypto/random.h"
#include "crypto/secure_util.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#include <sddl.h>
#else
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace abr {
namespace {

// Keep bootstrap, JSON depth, and wire allocation within fixed bounds.
constexpr size_t kMaximumFrame = 4 * 1024 * 1024;
constexpr size_t kMaximumBootstrap = 4096;
constexpr char kBrowserCommit[] = "634b046faf2137b83af71c87baf362b533af9104";
constexpr char kObserverVersion[] = "0.1.0";
using OperationDeadline = std::optional<std::chrono::steady_clock::time_point>;

// Encode a bounded versioned value into a compact UTF-8 JSON string.
// Args:
//   value: Sanitized protocol data.
// Returns:
//   optional<string>: A bounded serialization or an unavailable result.
std::optional<std::string> Encode(const base::Value& value) {
  auto bytes = base::WriteJson(value);
  // Reject oversized responses before allocating an outgoing frame.
  if (!bytes || bytes->empty() || bytes->size() > kMaximumFrame) {
    return std::nullopt;
  }
  return bytes;
}

// Validate an opaque identifier used for a profile or request.
// Args:
//   value: Untrusted IPC identifier.
// Returns:
//   bool: Whether the identifier has an ASCII portable bounded shape.
bool Identifier(std::string_view value) {
  // Restrict identifiers independently from payload contents.
  if (value.empty() || value.size() > 128) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return (character >= 'a' && character <= 'z') ||
           (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '-' ||
           character == '_';
  });
}

// AuthenticationKey
// Keep decoded authentication material private and clear it on every lifecycle exit.
struct AuthenticationKey {
  std::array<uint8_t, 32> bytes = {};
  // Clear the complete authentication key before releasing its private stack storage.
  // Args:
  //   None: This object owns the decoded inherited bootstrap key.
  // Returns:
  //   None: The platform-backed secure clearing operation has completed.
  ~AuthenticationKey() { crypto::SecureZeroBuffer(bytes); }
};

// Build a closed successful private authentication response.
// Args:
//   identifier: Validated request correlation identifier.
//   result: Exact public challenge metadata and proof.
// Returns:
//   Value: An outer schema-version-one response.
base::Value AuthenticationResponse(const std::string& identifier, base::DictValue result) {
  base::DictValue response;
  response.Set("schemaVersion", 1);
  response.Set("requestId", identifier);
  response.Set("ok", true);
  response.Set("result", std::move(result));
  return base::Value(std::move(response));
}

#if BUILDFLAG(IS_WIN)
// KernelHandle
// Release an owned Windows pipe, event, token, or process handle.
class KernelHandle {
 public:
  // Take ownership of a valid Windows handle.
  // Args:
  //   handle: Handle obtained through a successful native creation call.
  // Returns:
  //   KernelHandle: A unique native handle owner.
  explicit KernelHandle(HANDLE handle) : handle_(handle) {}
  KernelHandle(const KernelHandle&) = delete;
  KernelHandle& operator=(const KernelHandle&) = delete;
  // Close the owned Windows handle.
  // Args:
  //   None: This object owns one native kernel reference.
  // Returns:
  //   None: The kernel resource is released.
  ~KernelHandle() {
    // Invalid handles carry no native ownership.
    if (handle_ && handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
  }
  // Return the borrowed handle for one native call.
  // Args:
  //   None: Ownership remains in this object.
  // Returns:
  //   HANDLE: The borrowed native handle.
  HANDLE get() const { return handle_; }
 private:
  HANDLE handle_;
};

// Wait for an overlapped pipe operation while respecting shutdown and a deadline.
// Args:
//   pipe: Owned overlapped pipe handle.
//   operation: One pending Windows operation and its event.
//   stopped: Browser lifecycle cancellation.
//   deadline: Maximum pending operation duration.
//   transferred: Number of transferred bytes on success.
// Returns:
//   bool: Whether the complete native operation succeeded.
bool AwaitOperation(HANDLE pipe, OVERLAPPED* operation,
                    std::atomic<bool>* stopped, std::chrono::milliseconds deadline,
                    DWORD* transferred) {
  const auto started = std::chrono::steady_clock::now();
  // Poll the operation event without blocking browser shutdown.
  while (!stopped->load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() - started < deadline) {
    const DWORD status = WaitForSingleObject(operation->hEvent, 50);
    // A signaled event is resolved through the overlapped byte count.
    if (status == WAIT_OBJECT_0) {
      return GetOverlappedResult(pipe, operation, transferred, FALSE) != FALSE;
    }
    // Unexpected wait results invalidate the operation.
    if (status != WAIT_TIMEOUT) {
      break;
    }
  }
  CancelIoEx(pipe, operation);
  // Keep the stack OVERLAPPED alive until its cancellation is complete.
  GetOverlappedResult(pipe, operation, transferred, TRUE);
  return false;
}

// PipeChannel
// Carry one current-user Windows named pipe connection with bounded operations.
class PipeChannel {
 public:
  // Own one protected server pipe and its lifecycle flag.
  // Args:
  //   pipe: Created named pipe handle.
  //   stopped: Browser lifecycle flag.
  // Returns:
  //   PipeChannel: A protected byte channel.
  PipeChannel(HANDLE pipe, std::atomic<bool>* stopped)
      : pipe_(pipe), stopped_(stopped) {}
  // Accept only the controller PID selected in the inherited bootstrap.
  // Args:
  //   parent_pid: Trusted bootstrap controller process identifier.
  // Returns:
  //   bool: Whether the expected local controller connected.
  bool Accept(int parent_pid) {
    KernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    OVERLAPPED operation = {};
    operation.hEvent = event.get();
    DWORD transferred = 0;
    const BOOL connected = ConnectNamedPipe(pipe_.get(), &operation);
    const DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    // Overlapped acceptance handles both raced and pending connections.
    if (error != ERROR_SUCCESS && error != ERROR_PIPE_CONNECTED &&
        (error != ERROR_IO_PENDING ||
         !AwaitOperation(pipe_.get(), &operation, stopped_,
                         std::chrono::seconds(30), &transferred))) {
      return false;
    }
    ULONG client_pid = 0;
    return GetNamedPipeClientProcessId(pipe_.get(), &client_pid) &&
           client_pid == static_cast<ULONG>(parent_pid);
  }
  // Read exactly one bounded byte range from the private controller.
  // Args:
  //   bytes: Destination range.
  //   length: Required byte count.
  //   deadline: Optional absolute private authentication deadline.
  // Returns:
  //   bool: Whether the whole range arrived before shutdown or a deadline.
  bool Read(uint8_t* bytes, size_t length, OperationDeadline deadline = std::nullopt) {
    return Transfer(bytes, length, false, deadline);
  }
  // Write exactly one bounded byte range to the private controller.
  // Args:
  //   bytes: Sanitized source range.
  //   length: Required byte count.
  //   deadline: Optional absolute private authentication deadline.
  // Returns:
  //   bool: Whether the whole range was transferred.
  bool Write(const uint8_t* bytes, size_t length, OperationDeadline deadline = std::nullopt) {
    return Transfer(const_cast<uint8_t*>(bytes), length, true, deadline);
  }
 private:
  // Perform complete overlapped pipe reads or writes.
  // Args:
  //   bytes: Byte buffer for the requested direction.
  //   length: Bounded buffer length.
  //   writing: Whether to send the buffer.
  //   deadline: Optional absolute deadline shared across the complete handshake frame.
  // Returns:
  //   bool: Complete byte transfer status.
  bool Transfer(uint8_t* bytes, size_t length, bool writing, OperationDeadline deadline) {
    size_t offset = 0;
    // Split partial native operations while preserving the complete frame order.
    while (offset < length && !stopped_->load(std::memory_order_acquire)) {
      auto remaining = std::chrono::milliseconds(writing ? 5000 : 3600000);
      // Authentication fragments share one absolute deadline rather than extending it per transfer.
      if (deadline) {
        const auto available = std::chrono::duration_cast<std::chrono::milliseconds>(
            *deadline - std::chrono::steady_clock::now());
        if (available <= std::chrono::milliseconds::zero()) { return false; }
        remaining = std::min(remaining, available);
      }
      KernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      OVERLAPPED operation = {};
      operation.hEvent = event.get();
      DWORD transferred = 0;
      const DWORD count = static_cast<DWORD>(length - offset);
      const BOOL complete = writing
          ? WriteFile(pipe_.get(), bytes + offset, count, &transferred, &operation)
          : ReadFile(pipe_.get(), bytes + offset, count, &transferred, &operation);
      // Pending reads remain interruptible while idle controllers keep the session open.
      if (!complete && (GetLastError() != ERROR_IO_PENDING ||
          !AwaitOperation(pipe_.get(), &operation, stopped_,
                          remaining,
                          &transferred))) {
        return false;
      }
      // Zero-byte transfers identify EOF and avoid an infinite retry loop.
      if (transferred == 0 || transferred > count) {
        return false;
      }
      offset += transferred;
    }
    return offset == length;
  }
  KernelHandle pipe_;
  std::atomic<bool>* stopped_;
};

// Create a named pipe with an explicit current-user SID access descriptor.
// Args:
//   bootstrap: Validated endpoint and controller authorization.
//   stopped: Browser lifecycle flag.
// Returns:
//   unique_ptr<PipeChannel>: A private local channel or unavailable result.
std::unique_ptr<PipeChannel> CreateChannel(const Bootstrap& bootstrap,
                                          std::atomic<bool>* stopped) {
  // Enforce the private observer namespace and reject arbitrary pipe paths.
  constexpr std::string_view prefix = "\\\\.\\pipe\\abr-observer-";
  if (!bootstrap.endpoint.starts_with(prefix) ||
      !Identifier(std::string_view(bootstrap.endpoint).substr(prefix.size()))) {
    return nullptr;
  }
  HANDLE token_raw = nullptr;
  // Request only token identity information under the current browser token.
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token_raw)) {
    return nullptr;
  }
  KernelHandle token(token_raw);
  DWORD required = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &required);
  // Limit aligned token storage before reading the current SID.
  if (required == 0 || required > 65536) {
    return nullptr;
  }
  std::vector<uintptr_t> storage((required + sizeof(uintptr_t) - 1) /
                                sizeof(uintptr_t));
  if (!GetTokenInformation(token.get(), TokenUser, storage.data(), required,
                           &required)) {
    return nullptr;
  }
  LPWSTR sid_raw = nullptr;
  if (!ConvertSidToStringSidW(
          reinterpret_cast<TOKEN_USER*>(storage.data())->User.Sid, &sid_raw)) {
    return nullptr;
  }
  std::wstring descriptor_text = L"D:P(A;;GA;;;";
  descriptor_text += sid_raw;
  descriptor_text += L")";
  LocalFree(sid_raw);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          descriptor_text.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
    return nullptr;
  }
  SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  HANDLE pipe = CreateNamedPipeW(base::UTF8ToWide(bootstrap.endpoint).c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 65536, 65536, 0, &attributes);
  LocalFree(descriptor);
  // A occupied endpoint or rejected ACL fails closed.
  if (pipe == INVALID_HANDLE_VALUE) {
    return nullptr;
  }
  return std::make_unique<PipeChannel>(pipe, stopped);
}
#else
// PipeChannel
// Carry a current-user Unix-domain connection with bounded polling and ownership.
class PipeChannel {
 public:
  // Own a protected listening socket and its temporary endpoint.
  // Args:
  //   socket: Listening Unix-domain socket.
  //   endpoint: Owned socket filename.
  //   stopped: Browser lifecycle flag.
  // Returns:
  //   PipeChannel: A private Unix byte channel.
  PipeChannel(int socket, std::string endpoint, std::atomic<bool>* stopped)
      : server_(socket), endpoint_(std::move(endpoint)), stopped_(stopped) {}
  // Close owned sockets and remove only the created endpoint.
  // Args:
  //   None: This object owns its sockets and its endpoint.
  // Returns:
  //   None: Unix channel resources are released.
  ~PipeChannel() {
    if (client_ >= 0) { close(client_); }
    close(server_);
    unlink(endpoint_.c_str());
  }
  // Accept a current-user controller with the exact bootstrap PID.
  // Args:
  //   parent_pid: Launching controller PID.
  // Returns:
  //   bool: Whether peer credentials identify the authorized controller.
  bool Accept(int parent_pid) {
    const auto started = std::chrono::steady_clock::now();
    // Poll connection availability so shutdown cancels acceptance.
    while (!stopped_->load(std::memory_order_acquire) &&
           std::chrono::steady_clock::now() - started < std::chrono::seconds(30)) {
      pollfd wait = {server_, POLLIN, 0};
      if (poll(&wait, 1, 50) <= 0) { continue; }
      client_ = accept(server_, nullptr, nullptr);
      if (client_ < 0) { return false; }
#if BUILDFLAG(IS_MAC)
      int suppress_signal = 1;
      // A controller disconnect produces an IO failure instead of a browser SIGPIPE.
      if (setsockopt(client_, SOL_SOCKET, SO_NOSIGPIPE, &suppress_signal, sizeof(suppress_signal)) != 0) { return false; }
#endif
#if BUILDFLAG(IS_LINUX)
      ucred credentials = {};
      socklen_t length = sizeof(credentials);
      return getsockopt(client_, SOL_SOCKET, SO_PEERCRED, &credentials, &length) == 0 &&
             credentials.uid == getuid() && credentials.pid == parent_pid;
#elif BUILDFLAG(IS_MAC)
      uid_t user = 0;
      gid_t group = 0;
      pid_t pid = 0;
      socklen_t length = sizeof(pid);
      return getpeereid(client_, &user, &group) == 0 && user == getuid() &&
             getsockopt(client_, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0 &&
             pid == parent_pid;
#else
      return false;
#endif
    }
    return false;
  }
  // Read a complete bounded byte range from the controller.
  // Args:
  //   bytes: Destination bytes.
  //   length: Required bounded range.
  //   deadline: Optional absolute private authentication deadline.
  // Returns:
  //   bool: Complete byte-transfer status.
  bool Read(uint8_t* bytes, size_t length, OperationDeadline deadline = std::nullopt) {
    return Transfer(bytes, length, false, deadline);
  }
  // Write a complete bounded byte range to the controller.
  // Args:
  //   bytes: Sanitized bytes.
  //   length: Required bounded range.
  //   deadline: Optional absolute private authentication deadline.
  // Returns:
  //   bool: Complete byte-transfer status.
  bool Write(const uint8_t* bytes, size_t length, OperationDeadline deadline = std::nullopt) {
    return Transfer(const_cast<uint8_t*>(bytes), length, true, deadline);
  }
 private:
  // Poll and transfer complete Unix byte ranges without unbounded shutdown waits.
  // Args:
  //   bytes: Byte buffer for the chosen direction.
  //   length: Buffer byte count.
  //   writing: Whether to send instead of receive.
  //   deadline: Optional absolute deadline shared across the complete handshake frame.
  // Returns:
  //   bool: Complete transfer status.
  bool Transfer(uint8_t* bytes, size_t length, bool writing, OperationDeadline deadline) {
    const auto started = std::chrono::steady_clock::now();
    size_t offset = 0;
    // Preserve byte order across partial socket transfers.
    while (offset < length && !stopped_->load(std::memory_order_acquire)) {
      // Bound private challenge and confirmation reads by the complete connection deadline.
      if (deadline && std::chrono::steady_clock::now() >= *deadline) { return false; }
      if (writing && std::chrono::steady_clock::now() - started > std::chrono::seconds(5)) { return false; }
      pollfd wait = {client_, static_cast<short>(writing ? POLLOUT : POLLIN), 0};
      if (poll(&wait, 1, 50) <= 0) { continue; }
      const ssize_t transferred = writing
          ? send(client_, bytes + offset, length - offset,
#if BUILDFLAG(IS_LINUX)
                 MSG_NOSIGNAL)
#else
                 0)
#endif
          : recv(client_, bytes + offset, length - offset, 0);
      if (transferred <= 0) { return false; }
      offset += static_cast<size_t>(transferred);
    }
    return offset == length;
  }
  int server_;
  int client_ = -1;
  std::string endpoint_;
  std::atomic<bool>* stopped_;
};

// Create an exclusive socket under a current-user 0700 runtime directory.
// Args:
//   bootstrap: Validated observer endpoint.
//   stopped: Browser lifecycle flag.
// Returns:
//   unique_ptr<PipeChannel>: A private socket or unavailable result.
std::unique_ptr<PipeChannel> CreateChannel(const Bootstrap& bootstrap,
                                          std::atomic<bool>* stopped) {
  const auto path = base::FilePath::FromUTF8Unsafe(bootstrap.endpoint);
  struct stat parent = {};
  // Reject shared runtime directories, path redirects, and reused endpoints.
  if (!path.IsAbsolute() || bootstrap.endpoint.size() >= sizeof(sockaddr_un::sun_path) ||
      lstat(path.DirName().value().c_str(), &parent) != 0 ||
      !S_ISDIR(parent.st_mode) || parent.st_uid != getuid() ||
      (parent.st_mode & 077) != 0 || base::PathExists(path)) {
    return nullptr;
  }
  const int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) { return nullptr; }
  sockaddr_un address = {};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, bootstrap.endpoint.c_str(), bootstrap.endpoint.size() + 1);
  // Bind once; cleanup removes only this newly created owned filename.
  if (bind(descriptor, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      chmod(bootstrap.endpoint.c_str(), 0600) != 0 || listen(descriptor, 1) != 0) {
    close(descriptor);
    return nullptr;
  }
  return std::make_unique<PipeChannel>(descriptor, bootstrap.endpoint, stopped);
}
#endif

// Read one private inherited bootstrap line with bounded shutdown polling.
// Args:
//   stopped: Browser lifecycle flag.
// Returns:
//   optional<string>: At most 4096 bytes from a private inherited pipe.
std::optional<std::string> ReadBootstrap(std::atomic<bool>* stopped) {
  std::string text;
  const auto started = std::chrono::steady_clock::now();
#if BUILDFLAG(IS_WIN)
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (GetFileType(input) != FILE_TYPE_PIPE) { return std::nullopt; }
#else
  struct stat metadata = {};
  // Node's private stdio pipe uses a Unix socketpair; both local stream types carry inherited bootstrap data.
  if (fstat(STDIN_FILENO, &metadata) != 0 ||
      (!S_ISFIFO(metadata.st_mode) && !S_ISSOCK(metadata.st_mode))) { return std::nullopt; }
#endif
  // Require a short complete bootstrap before starting any observation channel.
  while (text.size() < kMaximumBootstrap && !stopped->load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() - started < std::chrono::seconds(5)) {
    char byte = 0;
#if BUILDFLAG(IS_WIN)
    DWORD available = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { return std::nullopt; }
    if (available == 0) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
    DWORD read = 0;
    if (!ReadFile(input, &byte, 1, &read, nullptr) || read != 1) { return std::nullopt; }
#else
    pollfd wait = {STDIN_FILENO, POLLIN, 0};
    if (poll(&wait, 1, 50) <= 0) { continue; }
    if (read(STDIN_FILENO, &byte, 1) != 1) { return std::nullopt; }
#endif
    if (byte == '\n') { return text; }
    text.push_back(byte);
  }
  return std::nullopt;
}

// Validate the inherited bootstrap and its isolated profile ownership marker.
// Args:
//   bytes: Private bounded bootstrap JSON.
//   directory: Browser-selected isolated user data directory.
// Returns:
//   optional<Bootstrap>: Strict controller/profile authorization or unavailable result.
std::optional<Bootstrap> ParseBootstrap(const std::string& bytes,
                                        const base::FilePath& directory) {
  auto dictionary = base::JSONReader::ReadDict(bytes, base::JSON_PARSE_RFC, 8);
  if (!dictionary || dictionary->size() != 5 || dictionary->FindInt("schemaVersion") != 1) { return std::nullopt; }
  const auto* secret = dictionary->FindString("secret");
  const auto* endpoint = dictionary->FindString("endpoint");
  const auto* profile = dictionary->FindString("profileId");
  const auto pid = dictionary->FindInt("parentPid");
  // Validate secret and endpoint bounds without emitting their values.
  if (!secret || secret->size() != 64 || !endpoint || endpoint->empty() || endpoint->size() > 256 ||
      endpoint->find('\0') != std::string::npos || !profile || !Identifier(*profile) || !pid || *pid <= 0 ||
      !std::all_of(secret->begin(), secret->end(), [](char value) { return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'); })) {
    return std::nullopt;
  }
  std::string marker;
  // Read only the fixed ownership marker under the selected isolated profile.
  if (!directory.IsAbsolute() || base::IsLink(directory) ||
      !base::ReadFileToStringWithMaxSize(directory.AppendASCII(".abr-profile.json"), &marker, 2048)) { return std::nullopt; }
  auto ownership = base::JSONReader::ReadDict(marker, base::JSON_PARSE_RFC, 8);
  if (!ownership || ownership->FindInt("schemaVersion") != 1 ||
      !ownership->FindString("name") || *ownership->FindString("name") != *profile) { return std::nullopt; }
  return Bootstrap{*secret, *endpoint, *profile, *pid};
}

// Write a single metadata-only bootstrap line through the inherited stdout pipe.
// Args:
//   bootstrap: Authorized profile and endpoint metadata.
// Returns:
//   bool: Whether startup metadata was fully written.
bool Publish(const Bootstrap& bootstrap) {
  base::DictValue metadata;
  metadata.Set("schemaVersion", 1);
  metadata.Set("protocolVersion", 1);
  metadata.Set("authVersion", 2);
  metadata.Set("endpoint", bootstrap.endpoint);
  metadata.Set("profileId", bootstrap.profile_id);
  metadata.Set("observerVersion", kObserverVersion);
  metadata.Set("browserVersion", version_info::GetVersionNumber());
  metadata.Set("browserCommit", kBrowserCommit);
#if BUILDFLAG(IS_WIN)
  metadata.Set("pid", static_cast<int>(GetCurrentProcessId()));
#else
  metadata.Set("pid", static_cast<int>(getpid()));
#endif
  auto text = Encode(base::Value(std::move(metadata)));
  if (!text) { return false; }
  text->push_back('\n');
#if BUILDFLAG(IS_WIN)
  DWORD written = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text->data(),
                   static_cast<DWORD>(text->size()), &written, nullptr) && written == text->size();
#else
  return write(STDOUT_FILENO, text->data(), text->size()) == static_cast<ssize_t>(text->size());
#endif
}

// Read one complete length-prefixed UTF-8 JSON request from the private channel.
// Args:
//   channel: Authenticated-controller channel.
//   deadline: Optional absolute deadline for an unauthenticated handshake.
// Returns:
//   optional<DictValue>: A strictly shaped request or an EOF/protocol failure.
std::optional<base::DictValue> ReadRequest(PipeChannel* channel,
                                         OperationDeadline deadline = std::nullopt) {
  std::array<uint8_t, 4> header = {};
  if (!channel->Read(header.data(), header.size(), deadline)) { return std::nullopt; }
  const size_t length = (static_cast<size_t>(header[0]) << 24) |
      (static_cast<size_t>(header[1]) << 16) | (static_cast<size_t>(header[2]) << 8) | header[3];
  // Verify the frame length before allocating any peer-controlled storage.
  if (length == 0 || length > kMaximumFrame) { return std::nullopt; }
  std::string bytes(length, '\0');
  if (!channel->Read(reinterpret_cast<uint8_t*>(bytes.data()), length, deadline)) { return std::nullopt; }
  auto request = base::JSONReader::ReadDict(bytes, base::JSON_PARSE_RFC, 40);
  if (!request || request->size() != 4 || request->FindInt("schemaVersion") != 1 ||
      !request->FindString("requestId") || !Identifier(*request->FindString("requestId")) ||
      !request->FindString("method") || request->FindString("method")->size() > 64 ||
      !request->FindDict("params")) { return std::nullopt; }
  return request;
}

// Write one sanitized result through the bounded frame protocol.
// Args:
//   channel: Private authenticated controller channel.
//   response: Closed result or safe protocol error.
//   deadline: Optional absolute private authentication deadline.
// Returns:
//   bool: Complete response transfer status.
bool WriteResponse(PipeChannel* channel, const base::Value& response,
                    OperationDeadline deadline = std::nullopt) {
  auto bytes = Encode(response);
  // Return an explicit quota error while preserving the authenticated connection.
  if (!bytes && response.is_dict()) {
    const auto* identifier = response.GetDict().FindString("requestId");
    if (identifier) { bytes = Encode(ObserverFailure(*identifier, "INVALID_ARGUMENT", "The observation exceeds its protocol size limit")); }
  }
  if (!bytes) { return false; }
  const uint32_t length = static_cast<uint32_t>(bytes->size());
  const std::array<uint8_t, 4> header = {static_cast<uint8_t>(length >> 24),
      static_cast<uint8_t>(length >> 16), static_cast<uint8_t>(length >> 8), static_cast<uint8_t>(length)};
  return channel->Write(header.data(), header.size(), deadline) &&
         channel->Write(reinterpret_cast<const uint8_t*>(bytes->data()), bytes->size(), deadline);
}

}  // namespace

base::Value ObserverFailure(const std::string& request_id, const char* code,
                            const char* message) {
  base::DictValue error;
  error.Set("code", code);
  error.Set("message", message);
  error.Set("retryable", false);
  base::DictValue response;
  response.Set("schemaVersion", 1);
  response.Set("requestId", request_id);
  response.Set("ok", false);
  response.Set("error", std::move(error));
  return base::Value(std::move(response));
}

void ServeObserver(base::FilePath user_directory, std::atomic<bool>* stopped,
                   ObserverDispatch dispatch) {
  auto text = ReadBootstrap(stopped);
  if (!text) { return; }
  auto bootstrap = ParseBootstrap(*text, user_directory);
  std::fill(text->begin(), text->end(), '\0');
  if (!bootstrap) { return; }
  AuthenticationKey key;
  const bool decoded = base::HexStringToSpan(bootstrap->secret, key.bytes);
  // The key enters only through inherited stdin and stays absent from all request parameters.
  crypto::SecureZeroBuffer(base::as_writable_byte_span(bootstrap->secret));
  bootstrap->secret.clear();
  if (!decoded) { return; }
  auto channel = CreateChannel(*bootstrap, stopped);
  if (!channel || !Publish(*bootstrap) || !channel->Accept(bootstrap->parent_pid)) { return; }
  bool authenticated = false;
  bool challenge_issued = false;
  std::string client_nonce;
  std::string server_nonce;
#if BUILDFLAG(IS_WIN)
  const uint32_t server_pid = GetCurrentProcessId();
#else
  const uint32_t server_pid = static_cast<uint32_t>(getpid());
#endif
  const auto authentication_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  // Keep one ordered request stream with one controller and one role-separated handshake.
  while (!stopped->load(std::memory_order_acquire)) {
    const OperationDeadline deadline = authenticated ? std::nullopt : OperationDeadline(authentication_deadline);
    auto request = ReadRequest(channel.get(), deadline);
    if (!request) { break; }
    const std::string id = *request->FindString("requestId");
    const auto& params = *request->FindDict("params");
    const auto& method = *request->FindString("method");
    // Prove server possession before requesting any client proof or allowing UI-thread observation.
    if (!authenticated) {
      if (std::chrono::steady_clock::now() >= authentication_deadline) { break; }
      const auto* supplied_client_nonce = params.FindString("clientNonce");
      if (!challenge_issued && method == "observer.challenge" && params.size() == 2 &&
          params.FindInt("authVersion") == 2 && supplied_client_nonce && auth::LowerHex64(*supplied_client_nonce)) {
        challenge_issued = true;
        client_nonce = *supplied_client_nonce;
        const auto nonce_bytes = crypto::RandBytesAsArray<32>();
        server_nonce = base::HexEncodeLower(nonce_bytes);
        const auto transcript = auth::Transcript("observer", "server", server_pid, client_nonce, server_nonce);
        if (!transcript) { break; }
        const auto proof = crypto::hmac::SignSha256(key.bytes, base::as_byte_span(*transcript));
        base::DictValue result;
        result.Set("authVersion", 2);
        result.Set("serverPid", static_cast<double>(server_pid));
        result.Set("clientNonce", client_nonce);
        result.Set("serverNonce", server_nonce);
        result.Set("serverProof", base::HexEncodeLower(proof));
        if (!WriteResponse(channel.get(), AuthenticationResponse(id, std::move(result)), deadline)) { break; }
        continue;
      }
      const auto* supplied_server_nonce = params.FindString("serverNonce");
      const auto* supplied_proof = params.FindString("clientProof");
      std::array<uint8_t, 32> proof = {};
      const auto transcript = auth::Transcript("observer", "client", server_pid, client_nonce, server_nonce);
      if (!challenge_issued || method != "observer.hello" || params.size() != 4 ||
          params.FindInt("authVersion") != 2 || !supplied_client_nonce || !supplied_server_nonce ||
          !supplied_proof || *supplied_client_nonce != client_nonce || *supplied_server_nonce != server_nonce ||
          !auth::LowerHex64(*supplied_proof) || !base::HexStringToSpan(*supplied_proof, proof) ||
          !transcript || !crypto::hmac::VerifySha256(key.bytes, base::as_byte_span(*transcript), proof) ||
          std::chrono::steady_clock::now() >= authentication_deadline) {
        WriteResponse(channel.get(), ObserverFailure(id, "POLICY_DENIED", "Observer authentication failed"), deadline);
        break;
      }
      authenticated = true;
      crypto::SecureZeroBuffer(key.bytes);
    } else if (method == "observer.hello" || method == "observer.challenge") {
      WriteResponse(channel.get(), ObserverFailure(id, "INVALID_ARGUMENT", "Observer handshake is already complete"));
      break;
    }
    auto response = dispatch.Run(*bootstrap, std::move(*request));
    if (!WriteResponse(channel.get(), response, deadline)) { break; }
  }
  // Private key ownership securely clears every remaining exit path.
}

}  // namespace abr
