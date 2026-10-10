// -*- coding: utf-8 -*-
// privacy_policy.h
// Pure cached accessibility privacy rules
// =====================
// Classify bounded public field metadata before accessibility values reach IPC.

#ifndef CHROME_BROWSER_ABR_NATIVE_OBSERVER_PRIVACY_POLICY_H_
#define CHROME_BROWSER_ABR_NATIVE_OBSERVER_PRIVACY_POLICY_H_

#include <cstddef>
#include <string_view>

namespace abr::privacy {

// Fold one ASCII byte while preserving every other UTF-8 byte.
// Args:
//   value: One byte from bounded accessibility metadata.
// Returns:
//   unsigned char: The corresponding ASCII lowercase byte.
constexpr unsigned char AsciiLower(unsigned char value) {
  // ASCII folding preserves locale-independent protocol classification.
  return value >= 'A' && value <= 'Z'
      ? static_cast<unsigned char>(value + ('a' - 'A')) : value;
}

// Identify bytes that continue an ASCII identifier word.
// Args:
//   value: A neighboring UTF-8 byte.
// Returns:
//   bool: Whether the byte belongs to the ASCII letter, digit, or underscore set.
constexpr bool AsciiWordByte(unsigned char value) {
  const auto folded = AsciiLower(value);
  return (folded >= 'a' && folded <= 'z') ||
         (value >= '0' && value <= '9') || value == '_';
}

// Detect an independent Card word exclusively on eligible fields or labels.
// Args:
//   name: Cached accessibility name whose contents remain private to classification.
//   field_or_label: Whether the cached role identifies an input or associated label.
// Returns:
//   bool: Whether the node requires Card field privacy filtering.
constexpr bool SensitiveCardName(std::string_view name, bool field_or_label) {
  // Document titles and generic container names preserve their public observation scope.
  if (!field_or_label) { return false; }
  // Scan word boundaries rather than matching unrelated words such as Cardboard.
  for (std::size_t index = 0; index + 4 <= name.size(); ++index) {
    if (AsciiLower(name[index]) != 'c' || AsciiLower(name[index + 1]) != 'a' ||
        AsciiLower(name[index + 2]) != 'r' || AsciiLower(name[index + 3]) != 'd') {
      continue;
    }
    if ((index != 0 && AsciiWordByte(name[index - 1])) ||
        (index + 4 != name.size() && AsciiWordByte(name[index + 4]))) {
      continue;
    }
    return true;
  }
  return false;
}

// Compare bounded ASCII metadata without allocating a normalized copy.
// Args:
//   first: Cached metadata token.
//   second: Fixed policy token.
// Returns:
//   bool: Whether both tokens have the same ASCII-insensitive byte sequence.
constexpr bool AsciiEqual(std::string_view first, std::string_view second) {
  // Length differences identify different complete metadata tokens.
  if (first.size() != second.size()) { return false; }
  // Preserve non-ASCII bytes while comparing the complete token.
  for (std::size_t index = 0; index < first.size(); ++index) {
    if (AsciiLower(first[index]) != AsciiLower(second[index])) { return false; }
  }
  return true;
}

// Classify sensitive autocomplete semantics when HTML metadata is already cached.
// Args:
//   value: Existing cached HTML autocomplete attribute.
// Returns:
//   bool: Whether a complete token denotes card, password, or one-time-code data.
constexpr bool SensitiveAutocomplete(std::string_view value) {
  std::size_t offset = 0;
  // HTML autocomplete supports section and address prefixes before its field token.
  while (offset < value.size()) {
    const auto start = value.find_first_not_of(" \t\r\n\f\v", offset);
    if (start == std::string_view::npos) { break; }
    const auto end = value.find_first_of(" \t\r\n\f\v", start);
    const auto token = value.substr(start, end == std::string_view::npos ? end : end - start);
    if ((token.size() >= 3 && AsciiLower(token[0]) == 'c' &&
         AsciiLower(token[1]) == 'c' && token[2] == '-') ||
        AsciiEqual(token, "current-password") || AsciiEqual(token, "new-password") ||
        AsciiEqual(token, "one-time-code")) {
      return true;
    }
    if (end == std::string_view::npos) { break; }
    offset = end;
  }
  return false;
}

// Validate one trusted literal sensitive-name pattern before any cached tree traversal.
// Args:
//   pattern: A complete UTF-8 string from an authenticated request.
// Returns:
//   bool: Whether its nonempty byte count fits the fixed protocol policy.
constexpr bool ValidSensitivePattern(std::string_view pattern) {
  return !pattern.empty() && pattern.size() <= 256;
}

}  // namespace abr::privacy

#endif  // CHROME_BROWSER_ABR_NATIVE_OBSERVER_PRIVACY_POLICY_H_
