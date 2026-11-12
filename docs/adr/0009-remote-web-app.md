# ADR 0009 — Slice 3.2: the remote web app on a phone, with approvals

- Status: accepted (owner, 2026-11-12: a web app to "control my system from anywhere … secure
  connection so no one can expose to this connection"; "send all the approvals to the phone or
  any device from which I am accessing it"). The owner's Telegram account cannot make bots, so
  slice 3.1 cannot be used.

## Context
The owner steps away from the laptop; an AI tool (e.g. Claude) stops on a question or an
approval. From the phone they want to see what is on screen, answer it, tap a button or type a
prompt, ask Magnus to do something, and answer XtraOS's own approvals.

## Decision
1. **Network: Tailscale** (free for personal use), not a public address. The owner installs it
   on the PC and the phone and signs in; then `tailscale serve --bg 4747` gives the Magnus app an
   https address that only the owner's devices can reach (e.g. `https://mypc.tail1234.ts.net`).
   Magnus itself still listens on 127.0.0.1 only. Magnus is told that address in
   `MAGNUS_REMOTE_HOSTS`; with it empty, remote access is off.
2. **Device pairing.** On the PC dashboard, "Pair a device" makes a one-time code (8 characters,
   10 minutes, 5 tries; only its hash is stored). On the phone, `/pair` takes the code and a
   name; the phone gets its own random token in an HttpOnly, Secure, SameSite=Strict cookie
   (180 days). Only token hashes are stored (`~/.magnus/devices.json`). Devices are listed and
   removed on the PC dashboard.
3. **Access rule** (`checkAccess`, pure): a request to a remote host needs a paired device;
   this PC's loopback address needs the run token; any other Host is refused (DNS rebinding);
   every change needs the app's own Origin, and https for a remote host.
4. **The phone app (`/m`)**:
   - **Approvals**: XtraOS dialogs waiting for an answer, refreshed every 2 s while open. A device
     the owner allowed answers them with a signed answer (XtraOS ADR 0076): the device makes an
     ECDSA P-256 key in the browser (private key not extractable, IndexedDB); "Allow this device
     to answer" sends the public key to XtraOS, which asks on the PC screen showing the key's
     code. Magnus only relays; XtraOS checks every signature.
   - **Windows**: the PC's windows; a window's text and its controls; tap a button, or type into
     a field and press Enter. Straight through XtraOS (1-2 s), under XtraOS's rules: a send, a
     delete or a settings change raises an approval, which then appears in Approvals.
   - **Ask**: `magnus ask` (ADR 0007): the brain picks the tools.
5. Magnus reaches XtraOS through its command-line bridge (`xtraos-core call <method> - --json`).
6. Slice 3.1 (Telegram) stays: it is off unless a bot token is set.

## Consequences
- An unlocked paired phone can approve. Remove a lost phone on the PC dashboard (this also
  removes it from XtraOS's approvers).
- The phone app must be open to see new approvals (no push notifications yet).
- The PC must be on and reachable over Tailscale; desktop actions need it unlocked.

## Tests
Unit: the access rule (local, remote, other hosts, origins, https), device pairing (one-time
code, tries, expiry, only hashes stored, removal), the controls parser, bridge errors. XtraOS:
the signature rules (ADR 0076). Live on the owner's PC with `MAGNUS_REMOTE_HOSTS=localhost:4747`
(the browser pane as the phone): see docs/03.
