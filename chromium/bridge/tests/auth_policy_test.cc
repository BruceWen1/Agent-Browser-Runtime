// -*- coding: utf-8 -*-
// auth_policy_test.cc
// Private authentication transcript interoperability checks
// =====================
// Verify production transcript policy against independent Windows CNG HMAC and fixed Node vectors.

#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../auth_policy.h"

// HashResources
// Release CNG test-only cryptographic handles on every verification exit.
struct HashResources {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  // Release the hash before its owning algorithm provider.
  // Args:
  //   None: The standalone test owns both CNG handles.
  // Returns:
  //   None: Native cryptographic resource cleanup has completed.
  ~HashResources() {
    if (hash) { BCryptDestroyHash(hash); }
    if (algorithm) { BCryptCloseAlgorithmProvider(algorithm, 0); }
  }
};

// Compute an independent HMAC-SHA256 for public deterministic interoperability fixtures.
// Args:
//   key: Fixed public test key bytes.
//   message: Canonical production transcript under test.
// Returns:
//   optional<array<uint8_t,32>>: Independent OS cryptographic result or provider failure.
std::optional<std::array<uint8_t, 32>> TestHmac(
    const std::array<uint8_t, 32>& key, const std::string& message) {
  HashResources resources;
  // Request the platform primitive SHA256 HMAC provider for independent verification.
  if (BCryptOpenAlgorithmProvider(&resources.algorithm, BCRYPT_SHA256_ALGORITHM,
                                  MS_PRIMITIVE_PROVIDER, BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0) {
    return std::nullopt;
  }
  DWORD object_length = 0;
  DWORD returned = 0;
  if (BCryptGetProperty(resources.algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_length), sizeof(object_length),
                        &returned, 0) < 0 || object_length == 0 || object_length > 65536) {
    return std::nullopt;
  }
  std::vector<uint8_t> object(object_length);
  // Test keys are public vector literals and their bytes are copied by the OS provider.
  if (BCryptCreateHash(resources.algorithm, &resources.hash, object.data(), object_length,
                       const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0) < 0 ||
      BCryptHashData(resources.hash,
                      reinterpret_cast<PUCHAR>(const_cast<char*>(message.data())),
                      static_cast<ULONG>(message.size()), 0) < 0) {
    return std::nullopt;
  }
  std::array<uint8_t, 32> digest = {};
  if (BCryptFinishHash(resources.hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
    return std::nullopt;
  }
  return digest;
}

// Render a public test digest with the protocol's canonical lowercase hexadecimal alphabet.
// Args:
//   bytes: Independent public fixture digest.
// Returns:
//   string: Complete canonical test proof.
std::string TestHex(const std::array<uint8_t, 32>& bytes) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string result;
  result.reserve(64);
  for (const uint8_t byte : bytes) {
    result.push_back(alphabet[byte >> 4]);
    result.push_back(alphabet[byte & 15]);
  }
  return result;
}

// Verify fixed transcripts and proof-domain separation using production policy code.
// Args:
//   None: Every key, nonce, PID, and expected proof is a public deterministic vector.
// Returns:
//   int: Zero when all strict metadata and independent HMAC checks pass.
int main() {
  const auto started = std::chrono::steady_clock::now();
  std::array<uint8_t, 32> key = {};
  for (size_t index = 0; index < key.size(); ++index) { key[index] = static_cast<uint8_t>(index); }
  const std::string client_nonce(64, '1');
  const std::string server_nonce(64, '2');
  // Canonical encodings close length, uppercase, injected separators, and process identity boundaries.
  if (!abr::auth::LowerHex64(client_nonce) || abr::auth::LowerHex64(std::string(64, 'A')) ||
      abr::auth::LowerHex64(std::string(63, '1')) ||
      abr::auth::Transcript("observer\nserver", "server", 12345, client_nonce, server_nonce) ||
      abr::auth::Transcript("observer", "server\nclient", 12345, client_nonce, server_nonce) ||
      abr::auth::Transcript("observer", "server", 0, client_nonce, server_nonce) ||
      abr::auth::Transcript("observer", "server", 12345, client_nonce, "short")) {
    std::cerr << "Authentication metadata boundary failed.\n";
    return 1;
  }
  const auto server = abr::auth::Transcript("observer", "server", 12345, client_nonce, server_nonce);
  const auto client = abr::auth::Transcript("observer", "client", 12345, client_nonce, server_nonce);
  const auto agent = abr::auth::Transcript("agent", "server", 12345, client_nonce, server_nonce);
  const auto agent_server_vector = abr::auth::Transcript("agent", "server", 4242, client_nonce, server_nonce);
  const auto agent_client_vector = abr::auth::Transcript("agent", "client", 4242, client_nonce, server_nonce);
  const auto other_pid = abr::auth::Transcript("observer", "server", 12346, client_nonce, server_nonce);
  const auto replay = abr::auth::Transcript("observer", "server", 12345, server_nonce, client_nonce);
  if (!server || !client || !agent || !agent_server_vector || !agent_client_vector || !other_pid || !replay ||
      *server != "abr-local-ipc-auth-v2\nobserver\nserver\n12345\n" + client_nonce + "\n" + server_nonce) {
    std::cerr << "Canonical authentication transcript failed.\n";
    return 1;
  }
  const auto server_proof = TestHmac(key, *server);
  const auto client_proof = TestHmac(key, *client);
  const auto agent_proof = TestHmac(key, *agent);
  const auto agent_server_proof = TestHmac(key, *agent_server_vector);
  const auto agent_client_proof = TestHmac(key, *agent_client_vector);
  const auto pid_proof = TestHmac(key, *other_pid);
  const auto replay_proof = TestHmac(key, *replay);
  // Node/OpenSSL fixed vectors are independently reproduced by the CNG provider.
  if (!server_proof || !client_proof || !agent_proof || !agent_server_proof || !agent_client_proof ||
      !pid_proof || !replay_proof ||
      TestHex(*server_proof) != "bd715130b9a9990b8e8ee0f88f06d2a6c3c59b199d1aabc97df122ebf4f20ed4" ||
      TestHex(*client_proof) != "7774e27d1afdf0440463eebf508dd1446b5ac04e33ec9cd31c9bcf15580dbfc1" ||
      TestHex(*agent_proof) != "fae9225e9aabd3163f92a53a25f8f938e248d0608ac11ee56027765e7933decc" ||
      TestHex(*agent_server_proof) != "688abbe6c1122ce1c75cf360ae31e0d225911bb4f60fe988592d5b0542034847" ||
      TestHex(*agent_client_proof) != "b59ba579af489654a76f865a64585f63eb74fadb266a828687ec59aae9e02aa0" ||
      *server_proof == *client_proof || *server_proof == *agent_proof ||
      *server_proof == *pid_proof || *server_proof == *replay_proof) {
    std::cerr << "Authentication HMAC interoperability or domain separation failed.\n";
    return 1;
  }
  key[0] ^= 1;
  const auto wrong_key_proof = TestHmac(key, *server);
  if (!wrong_key_proof || *wrong_key_proof == *server_proof) {
    std::cerr << "Authentication key separation failed.\n";
    return 1;
  }
  const auto elapsed = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started).count();
  std::cout << "auth-policy: strict fields, fixed vectors, direction, namespace, PID, nonce and key separation passed; durationMs="
            << elapsed << '\n';
  return 0;
}
