// -*- coding: utf-8 -*-
// windows-allocation.cs
// Native Windows allocated-storage measurement
// =====================
// Enumerate owned directories, including hidden entries, through bounded native filesystem calls.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;

/// AbrAllocation measures regular file allocation within a validated ordinary directory tree.
public static class AbrAllocation
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FindData
    {
        public uint Attributes;
        public FILETIME Creation;
        public FILETIME Access;
        public FILETIME Write;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Reserved0;
        public uint Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string AlternateName;
    }

    /// Open a native directory enumerator with hidden entries included.
    /// Args:
    ///   pattern (string): Extended native directory search pattern.
    ///   data (FindData): First returned filesystem entry metadata.
    /// Returns:
    ///   IntPtr: Enumerator handle or the native invalid-handle sentinel.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFileW(string pattern, out FindData data);

    /// Advance an existing native directory enumerator.
    /// Args:
    ///   handle (IntPtr): Owned directory enumerator.
    ///   data (FindData): Next filesystem entry metadata.
    /// Returns:
    ///   bool: Whether another entry was returned.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextFileW(IntPtr handle, out FindData data);

    /// Release an owned native directory enumerator.
    /// Args:
    ///   handle (IntPtr): Enumerator opened by this measurement.
    /// Returns:
    ///   bool: Whether the native handle was closed.
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr handle);

    /// Read actual sparse or compressed storage allocated to one regular file.
    /// Args:
    ///   path (string): Extended native regular-file path.
    ///   high (uint): High portion of the measured allocation.
    /// Returns:
    ///   uint: Low portion of the measured allocation or the documented error sentinel.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetCompressedFileSizeW(string path, out uint high);

    /// Clear native error state before a size query with a success-compatible sentinel.
    /// Args:
    ///   error (uint): Native error state to establish before the size query.
    /// Returns:
    ///   void: Completion of the thread-local native error reset.
    [DllImport("kernel32.dll")]
    private static extern void SetLastError(uint error);

    /// Measure a previously validated owned directory while pruning one exact root output scope.
    /// Args:
    ///   root (string): Ordinary absolute directory verified by the caller.
    ///   excluded (string): Exact root output directory or an empty exclusion.
    ///   noFollowLinks (bool): Whether links remain opaque and contribute no deducted storage estimate.
    /// Returns:
    ///   ulong: Sum of regular-file allocated bytes including hidden Git and dependency entries.
    public static ulong Measure(string root, string excluded, bool noFollowLinks = true)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        ulong total = 0;
        // Enumerate one directory at a time with bounded handle lifetime.
        while (pending.Count != 0)
        {
            string current = pending.Pop();
            FindData data;
            IntPtr handle = FindFirstFileW(@"\\?\" + current + @"\*", out data);
            // Reject unavailable scopes instead of returning a partial capacity estimate.
            if (handle == new IntPtr(-1))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Allocation enumeration failed");
            try
            {
                // Native metadata avoids PowerShell object construction for every source file.
                do
                {
                    // Skip native directory aliases without following any parent traversal.
                    if (data.Name == "." || data.Name == "..") continue;
                    string entry = current + @"\" + data.Name;
                    // Prune only the explicitly selected root build-output directory.
                    if (String.Equals(entry, excluded, StringComparison.OrdinalIgnoreCase)) continue;
                    // Preserve link opacity before opening or descending into an entry.
                    if ((data.Attributes & (uint)FileAttributes.ReparsePoint) != 0)
                    {
                        // Package and build-log links contribute no deducted storage estimate.
                        if (noFollowLinks) continue;
                        throw new IOException("Allocation scope contains path redirection: " + entry.Substring(root.Length + 1));
                    }
                    // Queue ordinary directories while retaining hidden-entry enumeration.
                    if ((data.Attributes & (uint)FileAttributes.Directory) != 0)
                    {
                        pending.Push(entry);
                        continue;
                    }
                    ulong size = ((ulong)data.SizeHigh << 32) + data.SizeLow;
                    // Ordinary files use the same size returned by the allocation API without reopening them.
                    if ((data.Attributes & (uint)(FileAttributes.Compressed | FileAttributes.SparseFile)) != 0)
                    {
                        uint high;
                        SetLastError(0);
                        uint low = GetCompressedFileSizeW(@"\\?\" + entry, out high);
                        // Distinguish a valid four-GiB sentinel from a failed allocation query.
                        if (low == UInt32.MaxValue && Marshal.GetLastWin32Error() != 0)
                            throw new IOException("Allocation measurement failed");
                        size = ((ulong)high << 32) + low;
                    }
                    total = checked(total + size);
                } while (FindNextFileW(handle, out data));
                // End-of-directory is the sole successful native enumeration termination.
                if (Marshal.GetLastWin32Error() != 18)
                    throw new IOException("Allocation enumeration failed");
            }
            finally
            {
                // Release the exact enumerator even when a scope or query is rejected.
                FindClose(handle);
            }
        }
        return total;
    }
}
