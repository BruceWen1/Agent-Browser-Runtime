// -*- coding: utf-8 -*-
/*
transport.rs
Current-user local transport
=====================

Create protected Windows named pipes and permission-restricted Unix sockets.
*/
use std::io;

#[cfg(windows)]
mod platform {
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
    };
    use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, OpenProcessToken,
    };

    /// Pipe supports simultaneous receive and send operations through distinct Windows events.
    pub struct Pipe(File);

    impl Pipe {
        /// Clone pipe handle ownership for the independent cancellation receiver.
        ///
        /// Args:
        ///     self (&Self): Protected connected pipe.
        /// Returns:
        ///     io::Result<Self>: Duplicate handle referencing the same connection.
        pub fn try_clone(&self) -> io::Result<Self> {
            self.0.try_clone().map(Self)
        }
    }

    /// Create a unique event for one overlapped pipe operation.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     io::Result<OVERLAPPED>: Owned event associated with the operation.
    fn operation() -> io::Result<OVERLAPPED> {
        let event = unsafe { CreateEventW(null_mut(), 1, 0, null_mut()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut operation: OVERLAPPED = unsafe { std::mem::zeroed() };
        operation.hEvent = event;
        Ok(operation)
    }

    /// Await a pending operation before releasing its unique event.
    ///
    /// Args:
    ///     handle (HANDLE): Protected pipe handle.
    ///     operation (&mut OVERLAPPED): Live operation with stable buffers.
    ///     succeeded (bool): Immediate API completion flag.
    ///     transferred (u32): Immediate byte count.
    /// Returns:
    ///     io::Result<usize>: Completed byte count.
    fn complete(
        handle: HANDLE,
        operation: &mut OVERLAPPED,
        succeeded: bool,
        mut transferred: u32,
    ) -> io::Result<usize> {
        let mut result = Ok(transferred as usize);
        // Await ERROR_IO_PENDING while preserving buffers and event storage.
        if !succeeded {
            let error = unsafe { GetLastError() };
            if error == ERROR_IO_PENDING {
                if unsafe { GetOverlappedResult(handle, operation, &mut transferred, 1) } == 0 {
                    result = Err(io::Error::last_os_error());
                } else {
                    result = Ok(transferred as usize);
                }
            } else {
                result = Err(io::Error::from_raw_os_error(error as i32));
            }
        }
        unsafe {
            CloseHandle(operation.hEvent);
        }
        result
    }

    impl Read for Pipe {
        /// Receive a bounded byte segment with an independent overlapped event.
        ///
        /// Args:
        ///     self (&mut Self): Connected current-user pipe.
        ///     bytes (&mut [u8]): Caller-owned receive buffer.
        /// Returns:
        ///     io::Result<usize>: Received byte count or clean disconnect.
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let mut operation = operation()?;
            let mut count = 0;
            let handle = self.0.as_raw_handle();
            let success = unsafe {
                ReadFile(
                    handle,
                    bytes.as_mut_ptr(),
                    bytes.len().min(u32::MAX as usize) as u32,
                    &mut count,
                    &mut operation,
                )
            } != 0;
            match complete(handle, &mut operation, success, count) {
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(0),
                value => value,
            }
        }
    }

    impl Write for Pipe {
        /// Send a bounded byte segment concurrently with the cancellation receiver.
        ///
        /// Args:
        ///     self (&mut Self): Connected current-user pipe.
        ///     bytes (&[u8]): Caller-owned send buffer.
        /// Returns:
        ///     io::Result<usize>: Sent byte count.
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let mut operation = operation()?;
            let mut count = 0;
            let handle = self.0.as_raw_handle();
            let success = unsafe {
                WriteFile(
                    handle,
                    bytes.as_ptr(),
                    bytes.len().min(u32::MAX as usize) as u32,
                    &mut count,
                    &mut operation,
                )
            } != 0;
            complete(handle, &mut operation, success, count)
        }
        /// Complete protocol flushing after all overlapped writes have settled.
        ///
        /// Args:
        ///     self (&mut Self): Connected current-user pipe.
        /// Returns:
        ///     io::Result<()>: Completion of already awaited writes.
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Query the current process user's canonical SID.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     io::Result<String>: Current user's SID string.
    pub fn current_sid() -> io::Result<String> {
        // Query the process token using checked sizes and owned Windows handles.
        unsafe {
            let mut token = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut required = 0;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
            // Preserve TOKEN_USER alignment while reserving its reported byte capacity.
            let mut bytes = vec![0_usize; (required as usize).div_ceil(size_of::<usize>())];
            if GetTokenInformation(
                token,
                TokenUser,
                bytes.as_mut_ptr().cast(),
                required,
                &mut required,
            ) == 0
            {
                CloseHandle(token);
                return Err(io::Error::last_os_error());
            }
            let user = &*(bytes.as_ptr().cast::<TOKEN_USER>());
            let mut text = null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                CloseHandle(token);
                return Err(io::Error::last_os_error());
            }
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            CloseHandle(token);
            Ok(result)
        }
    }

    /// Create a named pipe with a protected current-user-only DACL.
    ///
    /// Args:
    ///     endpoint (&str): Randomized local named pipe endpoint.
    /// Returns:
    ///     io::Result<File>: Connected duplex pipe owned by the agent.
    pub fn accept(endpoint: &str) -> io::Result<Pipe> {
        let sid = current_sid()?;
        let security: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let name: Vec<u16> = endpoint.encode_utf16().chain(Some(0)).collect();
        // Convert the explicit current-user DACL and transfer the pipe handle into File.
        unsafe {
            let mut descriptor = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                security.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let handle = CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                &attributes,
            );
            LocalFree(descriptor);
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut connect = operation()?;
            let connected = ConnectNamedPipe(handle, &mut connect) != 0;
            let already_connected = !connected && GetLastError() == ERROR_PIPE_CONNECTED;
            let result = complete(handle, &mut connect, connected || already_connected, 0);
            if result.is_err() {
                CloseHandle(handle);
                return Err(io::Error::last_os_error());
            }
            Ok(Pipe(File::from_raw_handle(handle)))
        }
    }

    /// Compute the local current-user named pipe endpoint.
    ///
    /// Args:
    ///     instance (&str): Random startup identifier supplied by the parent.
    ///     runtime_directory (&str): Reserved runtime directory argument.
    /// Returns:
    ///     io::Result<String>: Current-user scoped pipe name.
    pub fn endpoint(instance: &str, _runtime_directory: &str) -> io::Result<String> {
        Ok(format!("\\\\.\\pipe\\abr-{}-{instance}", current_sid()?))
    }
}

#[cfg(unix)]
mod platform {
    use std::fs;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    /// Accept a client through a permission-restricted Unix socket.
    ///
    /// Args:
    ///     endpoint (&str): Socket path inside the owned runtime directory.
    /// Returns:
    ///     io::Result<UnixStream>: Connected local client.
    pub fn accept(endpoint: &str) -> io::Result<UnixStream> {
        let parent = Path::new(endpoint).parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Socket parent is missing")
        })?;
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        let listener = UnixListener::bind(endpoint)?;
        fs::set_permissions(endpoint, fs::Permissions::from_mode(0o600))?;
        let (stream, _) = listener.accept()?;
        fs::remove_file(endpoint)?;
        Ok(stream)
    }

    /// Compute the owned local Unix socket endpoint.
    ///
    /// Args:
    ///     instance (&str): Random startup identifier supplied by the parent.
    ///     runtime_directory (&str): Owned directory selected by the parent.
    /// Returns:
    ///     io::Result<String>: Local Unix socket path.
    pub fn endpoint(instance: &str, runtime_directory: &str) -> io::Result<String> {
        Ok(Path::new(runtime_directory)
            .join(format!("abr-{instance}.sock"))
            .to_string_lossy()
            .into_owned())
    }
}

pub use platform::{accept, endpoint};

/// Validate a parent-supplied startup identifier.
///
/// Args:
///     instance (&str): Startup identifier used in the endpoint name.
/// Returns:
///     io::Result<()>: Completion of endpoint identifier validation.
pub fn validate_instance(instance: &str) -> io::Result<()> {
    // Admit bounded ASCII identifiers that cannot inject filesystem separators.
    if instance.is_empty()
        || instance.len() > 64
        || !instance
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid agent instance identifier",
        ));
    }
    Ok(())
}
