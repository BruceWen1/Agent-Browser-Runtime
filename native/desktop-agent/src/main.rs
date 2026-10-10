// -*- coding: utf-8 -*-
/*
main.rs
Desktop agent entry point
=====================

Serve authenticated, bounded local desktop requests and explicit capability diagnostics.
*/
mod approval;
mod authentication;
mod backend;
mod control;
mod protocol;
mod transport;

use std::collections::HashSet;
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::Instant;

use serde_json::json;

use authentication::Authenticator;
use protocol::{Request, Response, read_frame, valid_request, write_frame};

/// Serve authenticated desktop requests on the accepted local connection.
///
/// Args:
///     reader (R): Independently owned receive side of the protected transport.
///     stream (&mut W): Current-user protected transport send side.
///     secret (&str): Parent startup secret received through inherited input.
/// Returns:
///     io::Result<()>: Completion of connection processing.
fn serve<R: Read + Send + 'static, W: Write>(
    mut reader: R,
    stream: &mut W,
    secret: &str,
) -> io::Result<()> {
    let mut authentication = Authenticator::new(secret, std::process::id())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.message))?;
    let authenticated = Arc::new(AtomicBool::new(false));
    let reader_authenticated = Arc::clone(&authenticated);
    let bindings = Arc::new(Mutex::new(HashSet::<String>::new()));
    let reader_bindings = Arc::clone(&bindings);
    let (sender, receiver) = mpsc::sync_channel(32);
    // Keep receiving cancellation while the COM-affine dispatcher performs input.
    thread::spawn(move || {
        while let Ok(Some(bytes)) = read_frame(&mut reader) {
            if reader_authenticated.load(Ordering::Acquire)
                && let Ok(request) = serde_json::from_slice::<Request>(&bytes)
                && valid_request(&request)
                && request.method == "desktop.cancel"
                && let Some(id) = request
                    .params
                    .get("sessionId")
                    .and_then(|value| value.as_str())
            {
                backend::interrupt(id);
            }
            if sender.send(bytes).is_err() {
                break;
            }
        }
        // Stop all owned input immediately when the supervising connection ends.
        if let Ok(bindings) = reader_bindings.lock() {
            for id in bindings.iter() {
                backend::interrupt(id);
            }
        }
    });
    let mut desktop = backend::DesktopBackend::new();
    // Decode bounded frames until shutdown or local connection closure.
    while let Ok(bytes) = receiver.recv() {
        let request: Request = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                write_frame(
                    stream,
                    &Response::failure(
                        "invalid-request",
                        "INVALID_ARGUMENT",
                        "Invalid request envelope",
                    ),
                )?;
                continue;
            }
        };
        if !valid_request(&request) {
            write_frame(
                stream,
                &Response::failure(
                    &request.request_id,
                    "INVALID_ARGUMENT",
                    "Invalid protocol version or fields",
                ),
            )?;
            continue;
        }
        // Authenticate before admitting diagnostics or desktop operation dispatch.
        if !authenticated.load(Ordering::Acquire) {
            // A single challenge proves the server PID, namespace, nonce pair, and bootstrap key.
            let result = match request.method.as_str() {
                "agent.challenge" => authentication.challenge(&request.params),
                "agent.hello" => authentication.authenticate(&request.params).map(|()| {
                    authenticated.store(true, Ordering::Release);
                    json!({"authenticated":true,"schemaVersion":1,"authVersion":2})
                }),
                _ => Err(authentication::AuthError {
                    code: "POLICY_DENIED",
                    message: "Local authentication is required",
                }),
            };
            match result {
                Ok(value) => write_frame(stream, &Response::success(&request.request_id, value))?,
                Err(error) => {
                    // Authentication failures close the connection without revealing key or proof data.
                    write_frame(
                        stream,
                        &Response::failure(&request.request_id, error.code, error.message),
                    )?;
                    return Ok(());
                }
            }
            continue;
        }
        // Authenticated connections cannot reissue or replay the one-time authentication exchange.
        if matches!(request.method.as_str(), "agent.challenge" | "agent.hello") {
            write_frame(
                stream,
                &Response::failure(
                    &request.request_id,
                    "POLICY_DENIED",
                    "Local authentication exchange is already consumed",
                ),
            )?;
            continue;
        }
        let started = Instant::now();
        let response = match request.method.as_str() {
            "desktop.shutdown" => {
                write_frame(
                    stream,
                    &Response::success(&request.request_id, json!({"closed":true})),
                )?;
                return Ok(());
            }
            _ => match desktop.as_mut() {
                Ok(backend) => match backend.dispatch(&request.method, &request.params) {
                    Ok(value) => Response::success(&request.request_id, value),
                    Err(error) => {
                        let mut response =
                            Response::failure(&request.request_id, error.code, error.message);
                        if let Some(payload) = response.error.as_mut() {
                            payload.retryable = error.retryable;
                        }
                        response
                    }
                },
                Err(error) if request.method == "desktop.doctor" => Response::success(
                    &request.request_id,
                    json!({"schemaVersion":1,"platform":env::consts::OS,"input":false,"accessibility":false,"screenCapture":false,"reason":error.code}),
                ),
                Err(error) => Response::failure(&request.request_id, error.code, error.message),
            },
        };
        write_frame(stream, &response)?;
        // Track authenticated bindings for disconnect cancellation without storing action data.
        if response.ok
            && let Some(id) = request
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
            && let Ok(mut bindings) = bindings.lock()
        {
            if request.method == "desktop.bind" {
                bindings.insert(id.to_owned());
            } else if request.method == "desktop.unbind" {
                bindings.remove(id);
            }
        }
        eprintln!(
            "{}",
            json!({"event":"agent-request-finished","requestId":request.request_id,"durationMs":started.elapsed().as_millis()})
        );
    }
    Ok(())
}

/// Initialize agent bootstrap and serve the protected local transport.
///
/// Args:
///     None.
/// Returns:
///     io::Result<()>: Completion of the agent lifetime.
fn run() -> io::Result<()> {
    let started = Instant::now();
    let args: Vec<String> = env::args().skip(1).collect();
    // Serve local review in an independent process without exposing an IPC approval method.
    if args.as_slice() == ["--review"] {
        return approval::run();
    }
    // Start an independent session control surface through inherited local pipes.
    if args.as_slice() == ["--control"] {
        return control::run();
    }
    // Support a metadata-only diagnostic command without accepting input.
    if args.first().is_some_and(|value| value == "--doctor") {
        println!(
            "{}",
            match backend::DesktopBackend::new() {
                Ok(mut backend) => backend.dispatch("desktop.doctor", &json!({})).unwrap_or_else(|error| json!({"schemaVersion":1,"platform":env::consts::OS,"input":false,"accessibility":false,"screenCapture":false,"reason":error.code})),
                Err(error) => json!({"schemaVersion":1,"platform":env::consts::OS,"input":false,"accessibility":false,"screenCapture":false,"reason":error.code}),
            }
        );
        return Ok(());
    }
    if args.len() != 4 || args[0] != "--instance" || args[2] != "--runtime-dir" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Agent bootstrap arguments are invalid",
        ));
    }
    transport::validate_instance(&args[1])?;
    let mut secret = String::new();
    io::stdin().lock().take(129).read_line(&mut secret)?;
    let secret = secret.trim();
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Agent bootstrap secret is invalid",
        ));
    }
    let endpoint = transport::endpoint(&args[1], &args[3])?;
    println!(
        "{}",
        json!({"schemaVersion":1,"endpoint":endpoint,"pid":std::process::id()})
    );
    io::stdout().flush()?;
    let mut stream = transport::accept(&endpoint)?;
    eprintln!(
        "{}",
        json!({"event":"agent-connected","durationMs":started.elapsed().as_millis()})
    );
    let reader = stream.try_clone()?;
    serve(reader, &mut stream, secret)
}

/// Dispatch the native agent entry point.
///
/// Args:
///     None.
/// Returns:
///     (): Completion of the diagnostic process.
fn main() {
    // Report classified bootstrap failure while keeping credentials out of diagnostics.
    if let Err(error) = run() {
        eprintln!(
            "{}",
            json!({"event":"agent-failed","kind":format!("{:?}",error.kind())})
        );
        std::process::exit(1);
    }
}
