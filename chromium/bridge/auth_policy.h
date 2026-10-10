// -*- coding: utf-8 -*-
// auth_policy.h
// Private local authentication transcript policy
// =====================
// Construct canonical role-separated HMAC messages from strictly bounded public metadata.

#ifndef CHROME_BROWSER_ABR_NATIVE_OBSERVER_AUTH_POLICY_H_
#define CHROME_BROWSER_ABR_NATIVE_OBSERVER_AUTH_POLICY_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace abr::auth {

// Validate one complete lowercase hexadecimal nonce or proof.
// Args:
//   value: Untrusted private authentication field.
// Returns:
//   bool: Whether the field represents exactly 32 bytes with canonical lowercase encoding.
constexpr bool LowerHex64(std::string_view value) {
  // The fixed encoding gives every authentication field a unique ASCII representation.
  if (value.size() != 64) { return false; }
  for (const unsigned char byte : value) {
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) {
      return false;
    }
  }
  return true;
}

// Construct the complete private authentication transcript with explicit role separation.
// Args:
//   name_space: Fixed observer or agent transport namespace selected by the implementation.
//   direction: Fixed server or client proof direction.
//   server_pid: Expected owned server process identity.
//   client_nonce: Complete canonical client challenge nonce.
//   server_nonce: Complete canonical server challenge nonce.
// Returns:
//   optional<string>: The canonical ASCII transcript when all metadata is valid.
inline std::optional<std::string> Transcript(std::string_view name_space,
                                            std::string_view direction,
                                            std::uint32_t server_pid,
                                            std::string_view client_nonce,
                                            std::string_view server_nonce) {
  // Keep all separators and domains implementation-controlled rather than caller-configurable.
  if ((name_space != "observer" && name_space != "agent") ||
      (direction != "server" && direction != "client") || server_pid == 0 ||
      !LowerHex64(client_nonce) || !LowerHex64(server_nonce)) {
    return std::nullopt;
  }
  std::string transcript("abr-local-ipc-auth-v2\n");
  transcript.append(name_space);
  transcript.push_back('\n');
  transcript.append(direction);
  transcript.push_back('\n');
  transcript.append(std::to_string(server_pid));
  transcript.push_back('\n');
  transcript.append(client_nonce);
  transcript.push_back('\n');
  transcript.append(server_nonce);
  return transcript;
}

}  // namespace abr::auth

#endif  // CHROME_BROWSER_ABR_NATIVE_OBSERVER_AUTH_POLICY_H_
