# 06 — Your own relay (phone access from anywhere, no VPN)

The relay is a small server on the internet that passes **encrypted** messages between your PC
and your phone (ADR 0010). It cannot read them. You run it on your own free server.

## 1. Deploy the relay (once, about 20 minutes)

**Recommended: Oracle Cloud Always Free VM (Ubuntu).** Vercel cannot hold WebSockets open, so it
does not work for this. Railway works with the Dockerfile in `apps/relay`, within its plan.

1. In Oracle Cloud, create an Always Free VM (Oracle Linux 9 or Ubuntu) and note its public IP.
   The SSH user is `opc` on Oracle Linux and `ubuntu` on Ubuntu.
2. In Oracle Cloud → your VCN → Security List → add Ingress rules for TCP ports **80** and **443**
   from `0.0.0.0/0`.
3. On your PC, build the phone app into the relay folder, then copy the folder to the VM:
   ```
   npm run build -w @magnus/phone
   scp -r apps/relay opc@<VM-IP>:~/magnus-relay
   ```
4. On the VM:
   ```
   cd ~/magnus-relay && sudo bash deploy/setup-oracle.sh
   ```
   It installs Node.js (the official build, checksum verified; not through dnf, which runs a
   1 GB VM out of memory) and Caddy, runs the relay as a service, and gets a free https certificate
   for `<ip-with-dashes>.sslip.io` (no domain needed; `DOMAIN=you.example` to use your own).
5. On the 1 GB AMD VM this takes about 10 minutes and SSH may not answer meanwhile; that is the
   VM's small CPU share, not a failure.
6. Check from anywhere: `https://<ip-with-dashes>.sslip.io/healthz` shows `ok`.

## 2. Connect your PC (once)
```
magnus relay setup https://<ip-with-dashes>.sslip.io
magnus relay run          # keep it running (it reconnects by itself)
magnus autostart on       # start it (and XtraOS) at every sign-in, hidden; log: ~/.magnus/logs/relay.log
```

## 3. Pair your phone (once per phone)
On the PC dashboard (`npm run dashboard`), **Phones over your relay → Pair over the relay**, and
scan the QR code with the phone's camera. Or `magnus relay pair` prints the link.

On the phone: Approvals → **Allow this phone to answer**, and click Allow on the PC (check the
code matches). Add the page to the home screen to use it like an app.

## What is protected, and what is not
- The relay sees who connects when, and message sizes. It cannot read or change messages:
  they are encrypted with keys only your PC and phone hold, set up through the QR code.
- The QR code holds a one-time secret (10 minutes). Don't share a photo of it.
- The phone app's code comes from your relay; whoever controls that VM could change it.
- A lost phone: remove it on the PC dashboard (also removes its XtraOS approvals).

## Updating the phone app on the relay
After a change in `apps/phone`, rebuild and copy only the static files (the relay keeps running):
```
npm run build -w @magnus/phone
scp apps/relay/public/{app.js,index.html,style.css,manifest.webmanifest} opc@<VM-IP>:~/magnus-relay/public/
ssh opc@<VM-IP> "sudo cp ~/magnus-relay/public/* /opt/magnus-relay/public/ && sudo chown magnus:magnus /opt/magnus-relay/public/*"
```
Phones load the new version the next time the page is opened (files are served with no-cache).
