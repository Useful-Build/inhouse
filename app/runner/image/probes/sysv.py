"""SysV shared memory and thread helpers for the container probes (run.ts runs this as a pool user).

  create KEY MODE   shmget(KEY, 4096, IPC_CREAT | MODE) and print the id (KEY 0 is IPC_PRIVATE; MODE in octal)
  get KEY           shmget(KEY, 0, 0): print the id, or ERR <errno name> (asks for no permission: finds any key)
  attach KEY        shmget(KEY, 0, 0), then attach it: ATTACHED <id>, or ERR <errno name>
  give ID UID       IPC_SET: name UID the segment's owner (any creator may, without privilege)
  hold ID           attach the segment, print ATTACHED, and stay attached until stdin closes
  pthread-exit      start a thread that waits on stdin, print READY, then end the main thread with pthread_exit: the
                    leader becomes a zombie while the other thread lives on
"""
import ctypes
import errno
import os
import sys
import threading

libc = ctypes.CDLL(None, use_errno=True)
libc.shmget.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.c_int]
libc.shmat.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
libc.shmat.restype = ctypes.c_void_p
libc.shmctl.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]

IPC_CREAT = 0o1000
IPC_SET = 1
IPC_STAT = 2


def fail(what):
    e = ctypes.get_errno()
    print(f"ERR {errno.errorcode.get(e, e)} {what}", flush=True)
    sys.exit(1)


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "create":
        i = libc.shmget(int(args[0], 0), 4096, IPC_CREAT | int(args[1], 8))
        if i < 0:
            fail("shmget")
        print(i, flush=True)
    elif cmd == "get":
        i = libc.shmget(int(args[0], 0), 0, 0)
        if i < 0:
            fail("shmget")
        print(i, flush=True)
    elif cmd == "attach":
        i = libc.shmget(int(args[0], 0), 0, 0)
        if i < 0:
            fail("shmget")
        if libc.shmat(i, None, 0) in (None, ctypes.c_void_p(-1).value):
            fail("shmat")
        print(f"ATTACHED {i}", flush=True)
    elif cmd == "give":
        # struct shmid_ds starts with struct ipc_perm { key_t key; uid_t uid; ... } on glibc (x86_64 and arm64):
        # read it whole, change the owner, write it back.
        buf = ctypes.create_string_buffer(512)
        if libc.shmctl(int(args[0]), IPC_STAT, buf) < 0:
            fail("IPC_STAT")
        ctypes.c_uint32.from_buffer(buf, 4).value = int(args[1])
        if libc.shmctl(int(args[0]), IPC_SET, buf) < 0:
            fail("IPC_SET")
        print("GIVEN", flush=True)
    elif cmd == "hold":
        if libc.shmat(int(args[0]), None, 0) in (None, ctypes.c_void_p(-1).value):
            fail("shmat")
        print("ATTACHED", flush=True)
        sys.stdin.read()
    elif cmd == "pthread-exit":
        t = threading.Thread(target=sys.stdin.read)
        t.start()
        print(f"READY {os.getpid()}", flush=True)
        libc.pthread_exit(None)
    else:
        print(f"ERR unknown command {cmd}", flush=True)
        sys.exit(2)


main()
