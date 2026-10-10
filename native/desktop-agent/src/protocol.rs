// -*- coding: utf-8 -*-
/*
protocol.rs
Bounded local IPC protocol
=====================

Validate versioned request envelopes and encode length-prefixed JSON frames.
*/
use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// Frames have a hard allocation limit shared with the TypeScript client.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Request represents a closed versioned local operation envelope.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema_version: u32,
    pub request_id: String,
    pub method: String,
    pub params: Value,
}

/// ProtocolError contains bounded public diagnostic fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Response contains exactly one operation result or classified error.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub schema_version: u32,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

impl Response {
    /// Construct a successful protocol response.
    ///
    /// Args:
    ///     request_id (&str): Original operation identifier.
    ///     result (Value): Serializable operation result.
    /// Returns:
    ///     Self: Versioned successful response.
    pub fn success(request_id: &str, result: Value) -> Self {
        Self {
            schema_version: 1,
            request_id: request_id.to_owned(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    /// Construct a classified protocol failure.
    ///
    /// Args:
    ///     request_id (&str): Original operation identifier.
    ///     code (&str): Stable public error code.
    ///     message (&str): Bounded diagnostic text.
    /// Returns:
    ///     Self: Versioned failure response.
    pub fn failure(request_id: &str, code: &str, message: &str) -> Self {
        Self {
            schema_version: 1,
            request_id: request_id.to_owned(),
            ok: false,
            result: None,
            error: Some(ProtocolError {
                code: code.to_owned(),
                message: message.to_owned(),
                retryable: false,
            }),
        }
    }
}

/// Read a frame after validating its declared allocation size.
///
/// Args:
///     reader (&mut R): Authenticated local transport stream.
/// Returns:
///     io::Result<Option<Vec<u8>>>: Frame contents or clean end of stream.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    // Distinguish a clean connection close from a truncated frame header.
    let read = reader.read(&mut header[..1])?;
    if read == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_be_bytes(header) as usize;
    // Reject invalid allocations before creating the payload buffer.
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid frame length",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

/// Write one bounded JSON response to the local transport.
///
/// Args:
///     writer (&mut W): Authenticated local transport stream.
///     response (&Response): Validated response envelope.
/// Returns:
///     io::Result<()>: Completion of header and payload transmission.
pub fn write_frame<W: Write>(writer: &mut W, response: &Response) -> io::Result<()> {
    let bytes = serde_json::to_vec(response)?;
    // Enforce the same hard size bound for outbound responses.
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Response frame is too large",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

/// Validate a decoded request before dispatching any operation.
///
/// Args:
///     request (&Request): Deserialized local request.
/// Returns:
///     bool: Whether version, identifiers, and parameter shape are valid.
pub fn valid_request(request: &Request) -> bool {
    request.schema_version == 1
        && !request.request_id.is_empty()
        && request.request_id.len() <= 128
        && !request.method.is_empty()
        && request.method.len() <= 128
        && request.params.is_object()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Verify bounded framing preserves UTF-8 responses.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Completion of protocol assertions.
    #[test]
    fn unicode_roundtrip() {
        let response = Response::success("fixture", serde_json::json!({"text":"\u{4e2d}\u{6587}"}));
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &response).expect("response framing");
        let payload = read_frame(&mut Cursor::new(bytes))
            .expect("frame read")
            .expect("payload");
        let decoded: Value = serde_json::from_slice(&payload).expect("JSON decoding");
        assert_eq!(decoded["schemaVersion"], 1);
        assert_eq!(decoded["result"]["text"], "\u{4e2d}\u{6587}");
    }

    /// Verify oversized and truncated frames fail before dispatch.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Completion of frame rejection assertions.
    #[test]
    fn invalid_lengths() {
        assert!(
            read_frame(&mut Cursor::new(
                ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes()
            ))
            .is_err()
        );
        assert!(read_frame(&mut Cursor::new(vec![0, 0])).is_err());
        assert!(read_frame(&mut Cursor::new(vec![0, 0, 0, 3, 1])).is_err());
    }

    /// Verify request fields and schema versions remain closed.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Completion of request shape assertions.
    #[test]
    fn closed_requests() {
        assert!(serde_json::from_value::<Request>(serde_json::json!({"schemaVersion":1,"requestId":"x","method":"desktop.doctor","params":{},"extra":true})).is_err());
        let request: Request = serde_json::from_value(serde_json::json!({"schemaVersion":2,"requestId":"x","method":"desktop.doctor","params":{}})).expect("request decoding");
        assert!(!valid_request(&request));
    }
}
