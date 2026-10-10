// -*- coding: utf-8 -*-
// observer_transport.h
// Native observer authenticated transport
// =====================
// Define protected bootstrap data and a bounded browser-thread dispatch callback.

#ifndef CHROME_BROWSER_ABR_NATIVE_OBSERVER_OBSERVER_TRANSPORT_H_
#define CHROME_BROWSER_ABR_NATIVE_OBSERVER_OBSERVER_TRANSPORT_H_

#include <atomic>
#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/values.h"

namespace abr {

// Bootstrap
// Bind one private inherited bootstrap to its launching controller and profile.
struct Bootstrap {
  std::string secret;
  std::string endpoint;
  std::string profile_id;
  int parent_pid = 0;
};

using ObserverDispatch =
    base::RepeatingCallback<base::Value(const Bootstrap&, base::DictValue)>;

// Construct a closed protocol error without including browser or bootstrap data.
// Args:
//   request_id: Opaque authenticated request correlation identifier.
//   code: Stable runtime error identifier.
//   message: Fixed technical failure description.
// Returns:
//   base::Value: The versioned IPC error response.
base::Value ObserverFailure(const std::string& request_id,
                            const char* code,
                            const char* message);

// Serve one authenticated controller through a current-user local channel.
// Args:
//   user_directory: Canonical isolated browser data directory.
//   stopped: Browser lifecycle cancellation flag.
//   dispatch: Browser UI-thread read-only request dispatcher.
// Returns:
//   None: The local endpoint and session secret are released when serving ends.
void ServeObserver(base::FilePath user_directory,
                   std::atomic<bool>* stopped,
                   ObserverDispatch dispatch);

}  // namespace abr

#endif  // CHROME_BROWSER_ABR_NATIVE_OBSERVER_OBSERVER_TRANSPORT_H_
