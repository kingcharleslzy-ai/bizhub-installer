"""Windows-safe entry point for the fixed Generic Desktop Runtime."""

from __future__ import annotations

import ctypes
import os
import time
from typing import Any

import bizhub_runtime_entry as shared


def _parent_process_alive(parent_pid: int) -> bool:
    # os.kill(pid, 0) is not a read-only probe on Windows. Query the process
    # handle and exit code without sending a signal or acquiring write access.
    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.OpenProcess(process_query_limited_information, False, parent_pid)
    if not handle:
        return False
    exit_code = ctypes.c_ulong()
    try:
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


def _monitor_parent(server: Any, parent_pid: int) -> None:
    while not server.should_exit:
        if os.getppid() != parent_pid or not _parent_process_alive(parent_pid):
            server.should_exit = True
            return
        time.sleep(1)


shared._monitor_parent = _monitor_parent


if __name__ == "__main__":
    raise SystemExit(shared.main())
