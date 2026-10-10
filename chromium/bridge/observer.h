// -*- coding: utf-8 -*-
// observer.h
// Browser-owned native observation lifecycle
// =====================
// Start and stop an opt-in read-only service for one ABR-owned profile.

#ifndef CHROME_BROWSER_ABR_NATIVE_OBSERVER_OBSERVER_H_
#define CHROME_BROWSER_ABR_NATIVE_OBSERVER_OBSERVER_H_

namespace abr {

// Start the observer on the Chromium browser UI thread.
// Args:
//   None: The browser command line and inherited bootstrap select the scope.
// Returns:
//   None: An authorized bootstrap starts a protected local observation channel.
void StartNativeObserver();

// Stop the observer before browser profile and UI-thread teardown.
// Args:
//   None: The browser startup hook owns the observer lifetime.
// Returns:
//   None: Pending transport operations finish and the worker thread is joined.
void StopNativeObserver();

}  // namespace abr

#endif  // CHROME_BROWSER_ABR_NATIVE_OBSERVER_OBSERVER_H_
