# ADR 0011 — Start the relay connection and XtraOS at sign-in

- Status: accepted (owner: "Yes, auto-start", 2026-11-12)

## Context
The phone reaches the PC only while `magnus relay run` runs (ADR 0010). After a restart the owner
had to start it by hand, so the phone could not reach the PC from outside.

## Decision
1. `magnus autostart on | off | status` writes two entries in the user's startup list
   (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, no admin rights):
   - `MagnusRelay`: `powershell.exe -WindowStyle Hidden` running `node cli.js relay run --log
     ~/.magnus/logs/relay.log`. PowerShell keeps a hidden console, so Node shows no window; a
     brief flash at sign-in is possible.
   - `XtraOSCore`: the XtraOS core (a windowless program), as its installer's `-StartAtLogin` does.
   `off` removes exactly these two; other programs' entries are never touched.
2. `relay run` takes a lock (`~/.magnus/relay.lock`, its process id): a second start says it is
   already running and exits. A lock left by a process that ended does not count.
3. `--log <file>` sends the relay connection's lines to a file kept under about 1 MB.

## Consequences
- The entry points at this copy of Magnus (`packages/core/dist/src/cli.js`); after moving the
  folder, run `magnus autostart on` again.
- The PC must be signed in (not only switched on) for the relay connection to run.

## Tests
Unit: the command (paths with spaces and apostrophes), on/off with a fake startup list (others
untouched), the lock (held by another process, stale), log trimming. Live: the entry, started as
sign-in starts it, connected to the owner's relay with no visible window; a second start refused.
