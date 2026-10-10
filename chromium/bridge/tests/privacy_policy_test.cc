// -*- coding: utf-8 -*-
// privacy_policy_test.cc
// Standalone accessibility privacy boundary checks
// =====================
// Compile the production pure policy header against public field-label and wire-limit cases.

#include <chrono>
#include <iostream>
#include <string_view>

#include "../privacy_policy.h"

// Public label cases distinguish eligible inputs from containers and other complete words.
static_assert(abr::privacy::SensitiveCardName("Card", true));
static_assert(abr::privacy::SensitiveCardName("CARD", true));
static_assert(abr::privacy::SensitiveCardName("Payment card", true));
static_assert(abr::privacy::SensitiveCardName("Card / expiry", true));
static_assert(!abr::privacy::SensitiveCardName("Card", false));
static_assert(!abr::privacy::SensitiveCardName("Cardboard", true));
static_assert(!abr::privacy::SensitiveCardName("Discard", true));
static_assert(!abr::privacy::SensitiveCardName("Card2", true));
static_assert(!abr::privacy::SensitiveCardName("card_name", true));

// Existing cached HTML semantics strengthen field privacy without changing accessibility modes.
static_assert(abr::privacy::SensitiveAutocomplete("cc-number"));
static_assert(abr::privacy::SensitiveAutocomplete("section-payment billing CC-CSC"));
static_assert(abr::privacy::SensitiveAutocomplete("current-password"));
static_assert(abr::privacy::SensitiveAutocomplete("one-time-code"));
static_assert(!abr::privacy::SensitiveAutocomplete("email"));
static_assert(!abr::privacy::SensitiveAutocomplete("nickname"));

// Wire policy accepts complete nonempty patterns and enforces its independent UTF-8 byte cap.
constexpr std::string_view kPattern256 =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
constexpr std::string_view kPattern257 =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static_assert(kPattern256.size() == 256);
static_assert(kPattern257.size() == 257);
static_assert(abr::privacy::ValidSensitivePattern(kPattern256));
static_assert(!abr::privacy::ValidSensitivePattern(kPattern257));
static_assert(!abr::privacy::ValidSensitivePattern(""));
static_assert(abr::privacy::ValidSensitivePattern("Protected note"));

// Report successful execution of the compiled pure-policy boundary assertions.
// Args:
//   None: All fixtures are public compile-time metadata literals.
// Returns:
//   int: Zero after the compiled production policy assertions have succeeded.
int main() {
  const auto started = std::chrono::steady_clock::now();
  const auto elapsed = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started).count();
  std::cout << "privacy-policy: 21 compile-time assertions passed; durationMs="
            << elapsed << '\n';
  return 0;
}
