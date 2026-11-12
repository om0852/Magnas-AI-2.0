# ADR 0010 — Slice 3.3: the phone reaches the PC through an encrypted WebSocket relay

- Status: accepted (owner, 2026-11-12: "Why not to use WebSocket instead of Tailscale? … VPN …
  not secure for me"; "we can deploy the WebSocket on Railway or Vercel, or … free Oracle").
  ADR 0009 (Tailscale) stays as an option.

## Context
The phone on mobile data cannot open a connection to the laptop behind a home router. A server
on the internet in the middle is needed: the PC connects out to it, the phone connects to it,
it passes messages. The owner does not want a VPN on the phone, and does not want a provider to
be able to read the traffic.

## Decision
1. **Relay** (`apps/relay`): a small Node server, deployed by the owner (recommended: an Oracle
   Cloud Always Free VM; Vercel cannot hold WebSockets open). It serves the phone app's static
   files over https and passes WebSocket messages between one PC and its phones in a "room". It
   stores nothing and cannot read messages.
2. **End to end encryption.** Phone and PC each have an ECDH P-256 key pair (private keys never
   leave the device: WebCrypto non-extractable on the phone, DPAPI-protected on the PC). For each
   connection both send a random 16-byte nonce; the session key is HKDF-SHA-256 over the ECDH
   secret with salt = both nonces, info `magnus-e2e-v1`; messages are AES-256-GCM with a random
   12-byte IV and a sequence number that must grow (no replay within a session; a new session
   has a new key).
3. **Pairing through a QR code, not through the relay.** The PC dashboard shows a QR code with
   the link `https://<relay>/#p=<room, PC public key, pairing id, 32-byte pairing secret>`. The
   part after `#` is never sent to any server. The phone sends its public key with an HMAC made
   with the pairing secret; the PC checks it (one use, 10 minutes) and answers with its own HMAC,
   so each side knows the other is the one in the QR. After that both keys are pinned: a relay
   that tried to stand in the middle would not have them.
4. **The room.** A random id (128 bits) plus a room secret the PC proves to the relay; the relay
   keeps only its hash (first registration wins; the owner can reset the relay). Phones join by
   room id; a phone that is not paired cannot decrypt anything, and the PC ignores it.
5. **What the phone can do** is the same as ADR 0009 (Approvals, Windows, Ask), as encrypted RPC
   calls the PC runs locally. Answers to XtraOS dialogs stay signed by the phone's separate
   approval key (XtraOS ADR 0076).
6. **PC side:** `magnus relay run` (connects out, reconnects after a drop) and `magnus relay
   pair` / the dashboard's QR; settings in `~/.magnus/relay.json`, keys in the secret store.

## Consequences
- The phone app's code is served by the relay. Whoever controls the relay server could change
  that code and so attack the keys in the browser. The relay is the owner's own VM, so this is
  the owner's own trust; a self-installed app would remove it later.
- The relay sees who connects when and message sizes, not contents.
- No forward secrecy beyond the per-session key: a stolen phone or PC key would read sessions
  recorded later with it. Remove a lost phone on the PC.
- One more thing to run: the relay. Setup files: a Dockerfile and a Caddy config that gets a
  free TLS certificate (a free `sslip.io` name works without buying a domain).

## Tests
Unit: the protocol (derive, encrypt, decrypt, tampering, replay, wrong key, pairing MAC), the
relay (rooms, room secret, forwarding, size limits), the PC connector's RPC. End to end on this
PC: relay + PC connector + a phone client in Node, then the phone app in a browser.
