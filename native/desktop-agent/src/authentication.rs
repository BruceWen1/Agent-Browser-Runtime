// -*- coding: utf-8 -*-
//! authentication.rs
//! Current-process mutual local IPC authentication
//! =====================
//! Bind one connection to a unique bootstrap key, PID, direction, and expiring nonce pair.

use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

const AUTH_VERSION: u64 = 2;
const CHALLENGE_TTL: Duration = Duration::from_secs(10);
type HmacSha256 = Hmac<Sha256>;

/// AuthError carries fixed diagnostic metadata excluding keys, nonces, and proofs.
#[derive(Clone, Debug)]
pub struct AuthError {
    pub code: &'static str,
    pub message: &'static str,
}

/// PendingChallenge retains one connection's nonce pair until its single hello attempt.
struct PendingChallenge {
    client_nonce: String,
    server_nonce: String,
    issued: Instant,
}

/// ChallengeState prevents reissuing or replaying a connection challenge.
enum ChallengeState {
    Fresh,
    Pending(PendingChallenge),
    Consumed,
}

/// Authenticator owns a private bootstrap key and one expiring connection challenge.
pub struct Authenticator {
    secret: [u8; 32],
    pid: u32,
    state: ChallengeState,
}

impl Authenticator {
    /// Initialize a private authenticator for one independently supervised server process.
    ///
    /// Args:
    ///     secret: Exact lowercase hexadecimal 32-byte bootstrap key.
    ///     pid: Current native server process identity used by both transcript directions.
    ///
    /// Returns:
    ///     Result<Self, AuthError>: Private connection authenticator or a fixed bootstrap failure.
    pub fn new(secret: &str, pid: u32) -> Result<Self, AuthError> {
        // Bootstrap identity and key shape must be complete before accepting any challenge.
        if pid == 0 {
            return Err(invalid());
        }
        Ok(Self {
            secret: decode_hex(secret).ok_or_else(invalid)?,
            pid,
            state: ChallengeState::Fresh,
        })
    }

    /// Issue a cryptographic server proof before accepting any client credential proof.
    ///
    /// Args:
    ///     params: Closed authVersion/clientNonce challenge request.
    ///
    /// Returns:
    ///     Result<Value, AuthError>: Exact server challenge metadata or a fixed rejection.
    pub fn challenge(&mut self, params: &Value) -> Result<Value, AuthError> {
        self.challenge_with(params, Instant::now(), random_nonce)
    }

    /// Consume and verify the client proof in constant time under the connection deadline.
    ///
    /// Args:
    ///     params: Closed authVersion/clientNonce/serverNonce/clientProof hello request.
    ///
    /// Returns:
    ///     Result<(), AuthError>: Authenticated connection or a fixed proof failure.
    pub fn authenticate(&mut self, params: &Value) -> Result<(), AuthError> {
        self.authenticate_at(params, Instant::now())
    }

    /// Issue one challenge with injectable monotonic time and nonce source for isolated tests.
    ///
    /// Args:
    ///     params: Closed challenge request.
    ///     now: Monotonic challenge creation time.
    ///     nonce: Cryptographic production source or an explicit deterministic unit source.
    ///
    /// Returns:
    ///     Result<Value, AuthError>: Exact public proof response after nonce admission.
    fn challenge_with(
        &mut self,
        params: &Value,
        now: Instant,
        nonce: impl FnOnce() -> Result<[u8; 32], AuthError>,
    ) -> Result<Value, AuthError> {
        // Reserve the only attempt before parsing or querying the native random source.
        if !matches!(self.state, ChallengeState::Fresh) {
            self.state = ChallengeState::Consumed;
            return Err(denied());
        }
        self.state = ChallengeState::Consumed;
        if !closed_fields(params, &["authVersion", "clientNonce"])
            || params["authVersion"].as_u64() != Some(AUTH_VERSION)
        {
            return Err(invalid());
        }
        let client_nonce = hex_field(params, "clientNonce").ok_or_else(invalid)?;
        let server_nonce = encode_hex(&nonce()?);
        let message = transcript("agent", "server", self.pid, client_nonce, &server_nonce);
        let proof = signer(&self.secret, message.as_bytes())?
            .finalize()
            .into_bytes();
        let response = json!({"authVersion":AUTH_VERSION,"serverPid":self.pid,
            "clientNonce":client_nonce,"serverNonce":server_nonce,"serverProof":encode_hex(&proof)});
        self.state = ChallengeState::Pending(PendingChallenge {
            client_nonce: client_nonce.to_owned(),
            server_nonce,
            issued: now,
        });
        Ok(response)
    }

    /// Verify one hello attempt while irrevocably consuming its pending nonce pair.
    ///
    /// Args:
    ///     params: Closed hello request.
    ///     now: Monotonic proof verification time.
    ///
    /// Returns:
    ///     Result<(), AuthError>: Constant-time proof admission or a fixed failure.
    fn authenticate_at(&mut self, params: &Value, now: Instant) -> Result<(), AuthError> {
        // Every hello attempt consumes state, including wrong proofs and malformed request fields.
        let ChallengeState::Pending(pending) =
            std::mem::replace(&mut self.state, ChallengeState::Consumed)
        else {
            return Err(denied());
        };
        if !closed_fields(
            params,
            &["authVersion", "clientNonce", "serverNonce", "clientProof"],
        ) || params["authVersion"].as_u64() != Some(AUTH_VERSION)
            || !now
                .checked_duration_since(pending.issued)
                .is_some_and(|age| age < CHALLENGE_TTL)
        {
            return Err(denied());
        }
        let client_nonce = hex_field(params, "clientNonce").ok_or_else(denied)?;
        let server_nonce = hex_field(params, "serverNonce").ok_or_else(denied)?;
        if client_nonce != pending.client_nonce || server_nonce != pending.server_nonce {
            return Err(denied());
        }
        let proof = params["clientProof"]
            .as_str()
            .and_then(decode_hex)
            .ok_or_else(denied)?;
        let message = transcript("agent", "client", self.pid, client_nonce, server_nonce);
        // RustCrypto Mac verification compares proof bytes in constant time.
        signer(&self.secret, message.as_bytes())?
            .verify_slice(&proof)
            .map_err(|_| denied())
    }
}

/// Obtain a complete 256-bit nonce from the operating system's preferred random source.
///
/// Args:
///     None: The operating system supplies fresh cryptographic bytes.
///
/// Returns:
///     Result<[u8; 32], AuthError>: Complete nonce or a fixed random-source failure.
fn random_nonce() -> Result<[u8; 32], AuthError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AuthError {
        code: "INTERNAL_ERROR",
        message: "Local authentication nonce is unavailable",
    })?;
    Ok(bytes)
}

/// Build the exact ASCII proof transcript without a trailing newline.
///
/// Args:
///     namespace: Closed agent or observer proof domain used by independent test vectors.
///     direction: Server or client role for directional proof separation.
///     pid: Expected server process identity.
///     client_nonce: Complete lowercase client nonce.
///     server_nonce: Complete lowercase server nonce.
///
/// Returns:
///     String: Deterministic domain-separated protocol transcript.
fn transcript(
    namespace: &str,
    direction: &str,
    pid: u32,
    client_nonce: &str,
    server_nonce: &str,
) -> String {
    format!(
        "abr-local-ipc-auth-v2\n{namespace}\n{direction}\n{pid}\n{client_nonce}\n{server_nonce}"
    )
}

/// Initialize the HMAC-SHA256 state for signing or constant-time verification.
///
/// Args:
///     key: Private bootstrap bytes or an explicit published unit-test key.
///     message: Exact protocol or known-vector input bytes.
///
/// Returns:
///     Result<HmacSha256, AuthError>: Updated MAC state or a fixed implementation failure.
fn signer(key: &[u8], message: &[u8]) -> Result<HmacSha256, AuthError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| AuthError {
        code: "INTERNAL_ERROR",
        message: "Local authentication primitive is unavailable",
    })?;
    mac.update(message);
    Ok(mac)
}

/// Validate an exact protocol object field set without coercing unknown request data.
///
/// Args:
///     params: Incoming JSON object.
///     fields: Complete allowed field names for the current protocol message.
///
/// Returns:
///     bool: Whether every required field is present and all unknown fields are excluded.
fn closed_fields(params: &Value, fields: &[&str]) -> bool {
    params.as_object().is_some_and(|object| {
        object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
    })
}

/// Read one complete lowercase hexadecimal protocol nonce.
///
/// Args:
///     params: Incoming JSON object.
///     field: Required nonce field name.
///
/// Returns:
///     Option<&str>: Valid lowercase nonce without copying bootstrap or proof data.
fn hex_field<'a>(params: &'a Value, field: &str) -> Option<&'a str> {
    let value = params.get(field)?.as_str()?;
    decode_hex(value)?;
    Some(value)
}

/// Decode an exact lowercase 32-byte hexadecimal token.
///
/// Args:
///     value: Bootstrap key, nonce, or proof token.
///
/// Returns:
///     Option<[u8; 32]>: Complete decoded bytes when the token shape is valid.
fn decode_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut bytes = [0_u8; 32];
    // ASCII lowercase hex validation retains one strict representation for every transcript token.
    for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let high = nibble(pair[0])?;
        let low = nibble(pair[1])?;
        bytes[index] = high * 16 + low;
    }
    Some(bytes)
}

/// Decode one permitted lowercase ASCII hexadecimal digit.
///
/// Args:
///     value: Incoming token byte.
///
/// Returns:
///     Option<u8>: Numeric digit when the strict token alphabet is satisfied.
fn nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

/// Encode complete cryptographic bytes using lowercase hexadecimal.
///
/// Args:
///     bytes: Nonce or public proof bytes.
///
/// Returns:
///     String: Canonical lowercase protocol token.
fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    // Public proof encoding preserves exact byte order without formatting secret-bearing structures.
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 15)] as char);
    }
    output
}

/// Construct fixed bootstrap or challenge syntax diagnostics.
///
/// Args:
///     None: Diagnostic text is independent of protocol data.
///
/// Returns:
///     AuthError: Stable invalid-argument failure.
fn invalid() -> AuthError {
    AuthError {
        code: "INVALID_ARGUMENT",
        message: "Local authentication fields are invalid",
    }
}

/// Construct fixed invalid, expired, or replayed proof diagnostics.
///
/// Args:
///     None: Diagnostic text excludes authentication state.
///
/// Returns:
///     AuthError: Stable policy-denied failure.
fn denied() -> AuthError {
    AuthError {
        code: "POLICY_DENIED",
        message: "Local authentication proof is invalid or expired",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify real operating-system challenges remain unique across connections with the same client nonce.
    ///
    /// Args:
    ///     None: Two isolated authenticators use the operating-system random source.
    ///
    /// Returns:
    ///     None: Canonical nonces differ and cross-connection proof reuse is rejected.
    #[test]
    fn native_random_challenges_separate_connections() {
        let key = "11".repeat(32);
        let request = json!({"authVersion":2,"clientNonce":"22".repeat(32)});
        let mut first = Authenticator::new(&key, 4242).unwrap();
        let mut second = Authenticator::new(&key, 4242).unwrap();
        let left = first.challenge(&request).unwrap();
        let right = second.challenge(&request).unwrap();
        assert_ne!(left["serverNonce"], right["serverNonce"]);
        assert_ne!(left["serverProof"], right["serverProof"]);
        let message = transcript(
            "agent",
            "client",
            4242,
            left["clientNonce"].as_str().unwrap(),
            left["serverNonce"].as_str().unwrap(),
        );
        let proof = encode_hex(
            &signer(&[0x11; 32], message.as_bytes())
                .unwrap()
                .finalize()
                .into_bytes(),
        );
        let hello = json!({"authVersion":2,"clientNonce":left["clientNonce"],
            "serverNonce":left["serverNonce"],"clientProof":proof});
        assert!(second.authenticate(&hello).is_err());
        assert!(first.authenticate(&hello).is_ok());
    }

    /// Generate one explicit deterministic challenge for protocol-boundary tests.
    ///
    /// Args:
    ///     now: Monotonic fixture creation time.
    ///
    /// Returns:
    ///     (Authenticator, Value, Value): Private test authenticator, challenge, and valid client hello.
    fn fixture(now: Instant) -> (Authenticator, Value, Value) {
        let key = "11".repeat(32);
        let mut auth = Authenticator::new(&key, 4242).expect("valid unit bootstrap");
        let challenge = auth
            .challenge_with(
                &json!({"authVersion":2,"clientNonce":"22".repeat(32)}),
                now,
                || Ok([0x33; 32]),
            )
            .expect("unit challenge");
        let message = transcript(
            "agent",
            "client",
            4242,
            challenge["clientNonce"].as_str().unwrap(),
            challenge["serverNonce"].as_str().unwrap(),
        );
        let proof = encode_hex(
            &signer(&[0x11; 32], message.as_bytes())
                .unwrap()
                .finalize()
                .into_bytes(),
        );
        let hello = json!({"authVersion":2,"clientNonce":challenge["clientNonce"],
            "serverNonce":challenge["serverNonce"],"clientProof":proof});
        (auth, challenge, hello)
    }

    /// Verify the published RFC 4231 HMAC-SHA256 test case independently of the handshake schema.
    ///
    /// Args:
    ///     None: The test uses the published Hi There vector.
    ///
    /// Returns:
    ///     None: Exact known digest and constant-time verification pass.
    #[test]
    fn rfc_4231_sha256_vector() {
        let message = b"Hi There";
        let expected =
            decode_hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7").unwrap();
        let mac = signer(&[0x0b; 20], message).unwrap();
        assert_eq!(mac.clone().finalize().into_bytes().as_slice(), expected);
        assert!(mac.verify_slice(&expected).is_ok());
    }

    /// Verify exact protocol server and client tags against independently computed fixed vectors.
    ///
    /// Args:
    ///     None: The fixture uses key bytes 00 through 1f and fixed public nonce values.
    /// Returns:
    ///     (): Exact server proof and independently supplied client proof are accepted.
    #[test]
    fn exact_agent_protocol_vectors_match_independent_implementation() {
        let key: [u8; 32] = std::array::from_fn(|index| index as u8);
        let now = Instant::now();
        let mut auth = Authenticator::new(&encode_hex(&key), 4242).unwrap();
        let challenge = auth
            .challenge_with(
                &json!({"authVersion":2,"clientNonce":"11".repeat(32)}),
                now,
                || Ok([0x22; 32]),
            )
            .unwrap();
        assert_eq!(
            challenge["serverProof"],
            "688abbe6c1122ce1c75cf360ae31e0d225911bb4f60fe988592d5b0542034847"
        );
        let hello = json!({"authVersion":2,"clientNonce":"11".repeat(32),"serverNonce":"22".repeat(32),"clientProof":"b59ba579af489654a76f865a64585f63eb74fadb266a828687ec59aae9e02aa0"});
        assert!(auth.authenticate_at(&hello, now).is_ok());
    }

    /// Verify exact direction, namespace, PID, and nonce domains reject substituted client proofs.
    ///
    /// Args:
    ///     None: Deterministic fixture keys are independent of production bootstrap values.
    ///
    /// Returns:
    ///     None: Every cross-domain or substituted proof fails before authentication.
    #[test]
    fn domain_pid_direction_and_nonce_mismatch_fail() {
        let now = Instant::now();
        for (namespace, direction, pid) in [
            ("observer", "client", 4242),
            ("agent", "server", 4242),
            ("agent", "client", 4243),
        ] {
            let (mut auth, challenge, mut hello) = fixture(now);
            let message = transcript(
                namespace,
                direction,
                pid,
                challenge["clientNonce"].as_str().unwrap(),
                challenge["serverNonce"].as_str().unwrap(),
            );
            hello["clientProof"] = json!(encode_hex(
                &signer(&[0x11; 32], message.as_bytes())
                    .unwrap()
                    .finalize()
                    .into_bytes()
            ));
            assert!(auth.authenticate_at(&hello, now).is_err());
        }
        for field in ["clientNonce", "serverNonce"] {
            let (mut auth, _, mut hello) = fixture(now);
            hello[field] = json!("44".repeat(32));
            assert!(auth.authenticate_at(&hello, now).is_err());
        }
        let (_, challenge, _) = fixture(now);
        assert_eq!(challenge.as_object().unwrap().len(), 5);
        assert_eq!(challenge["authVersion"], 2);
        assert_eq!(challenge["serverPid"], 4242);
        assert!(!challenge.to_string().contains(&"11".repeat(32)));
    }

    /// Verify expiry, replay, duplicate challenge, and hello-before-challenge consume connection admission.
    ///
    /// Args:
    ///     None: Injected monotonic time avoids blocking sleeps.
    ///
    /// Returns:
    ///     None: Single-use and exact ten-second deadline assertions pass.
    #[test]
    fn expiry_replay_and_order_are_closed() {
        let now = Instant::now();
        let (mut auth, _, hello) = fixture(now);
        assert!(auth.authenticate_at(&hello, now + CHALLENGE_TTL).is_err());
        assert!(auth.authenticate_at(&hello, now).is_err());
        let (mut auth, _, hello) = fixture(now);
        assert!(
            auth.authenticate_at(&hello, now + Duration::from_secs(9))
                .is_ok()
        );
        assert!(auth.authenticate_at(&hello, now).is_err());
        assert!(
            auth.challenge(&json!({"authVersion":2,"clientNonce":"22".repeat(32)}))
                .is_err()
        );
        let mut before = Authenticator::new(&"11".repeat(32), 4242).unwrap();
        assert!(before.authenticate_at(&hello, now).is_err());
        assert!(
            before
                .challenge(&json!({"authVersion":2,"clientNonce":"22".repeat(32)}))
                .is_err()
        );
        let (mut duplicate, _, hello) = fixture(now);
        assert!(
            duplicate
                .challenge(&json!({"authVersion":2,"clientNonce":"22".repeat(32)}))
                .is_err()
        );
        assert!(duplicate.authenticate_at(&hello, now).is_err());
    }

    /// Verify strict field/version/hex schemas and failed hello attempts retain single-use semantics.
    ///
    /// Args:
    ///     None: Test values contain deliberate protocol mutations only.
    ///
    /// Returns:
    ///     None: Unknown fields, invalid version, uppercase hex, and wrong proofs fail.
    #[test]
    fn strict_messages_and_bad_proofs_consume_admission() {
        assert!(Authenticator::new("short", 4242).is_err());
        assert!(Authenticator::new(&"11".repeat(32), 0).is_err());
        for request in [
            json!({"authVersion":1,"clientNonce":"22".repeat(32)}),
            json!({"authVersion":2,"clientNonce":"AA".repeat(32)}),
            json!({"authVersion":2,"clientNonce":"22".repeat(32),"secret":"unused"}),
        ] {
            let mut auth = Authenticator::new(&"11".repeat(32), 4242).unwrap();
            assert!(
                auth.challenge_with(&request, Instant::now(), || Ok([0x33; 32]))
                    .is_err()
            );
        }
        for field in ["extra", "authVersion", "clientProof"] {
            let now = Instant::now();
            let (mut auth, _, valid) = fixture(now);
            let mut invalid = valid.clone();
            invalid[field] = match field {
                "extra" => json!(true),
                "authVersion" => json!(1),
                _ => json!("00".repeat(32)),
            };
            assert!(auth.authenticate_at(&invalid, now).is_err());
            assert!(auth.authenticate_at(&valid, now).is_err());
        }
        let mut real = Authenticator::new(&"11".repeat(32), 4242).unwrap();
        let challenge = real
            .challenge(&json!({"authVersion":2,"clientNonce":"22".repeat(32)}))
            .unwrap();
        assert!(decode_hex(challenge["serverNonce"].as_str().unwrap()).is_some());
    }
}
