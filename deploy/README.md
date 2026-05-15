# Raspberry Pi 4 deployment

Run LightEmUp 24/7 on a Pi 4B, reachable at `http://lightemup.local:8420`. You keep developing on Windows; deploys are `ssh pi@lightemup.local '~/lightemup/deploy/update.sh'`.

## 1. Get your SSH public key ready (on Windows)

The Pi Imager will bake your public key into the SD card so you can `ssh` in without typing a password.

```powershell
# Check if you already have one
Get-Content $HOME\.ssh\id_ed25519.pub
```

If that prints a `ssh-ed25519 AAAA…` line, copy it. If it errors with "Cannot find path":

```powershell
ssh-keygen -t ed25519 -C "dan@lightemup"
# Press Enter to accept the default path
# Press Enter twice to skip the passphrase
Get-Content $HOME\.ssh\id_ed25519.pub
```

Keep the public key text on your clipboard for the next step. The matching private key (`id_ed25519`, no `.pub`) stays on your Windows machine — never share it.

## 2. Flash the SD card (on Windows, before the Pi is plugged in)

1. Install **Raspberry Pi Imager** (https://www.raspberrypi.com/software/).
2. In the Imager:
   - **Choose Device** → **Raspberry Pi 4**
   - **Choose OS** → **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite (64-bit)** *(no desktop — headless server)*
   - **Choose Storage** → your SD card
3. Click **Next** → **Edit Settings** before writing, and set:
   - **General tab:**
     - **Hostname:** `lightemup`
     - **Username:** `pi`  &nbsp;&nbsp; **Password:** (something you'll remember)
     - **WiFi:** your SSID + password + country
     - **Locale:** your timezone
   - **Services tab:**
     - **Enable SSH** → **Use public-key authentication only** → paste the public key from step 1.
4. **Save** → **Yes** to apply settings → **Yes** to erase the card → write the image. Eject.
5. Put SD card in the Pi, plug in power.

First boot takes ~60s. The Pi will appear on your LAN as `lightemup.local`.

## 3. Add an SSH shortcut on Windows

Append to `C:\Users\Dan\.ssh\config` (create the file if missing):

```
Host lightemup
    HostName lightemup.local
    User pi
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

Now `ssh lightemup` from any PowerShell window just works.

## 4. First-time install on the Pi

```powershell
ssh lightemup
# (now on the Pi)
curl -fsSL https://raw.githubusercontent.com/dancfuller/LightEmUp/main/deploy/install.sh -o /tmp/install.sh
bash /tmp/install.sh
```

`install.sh` clones the repo to `/home/pi/lightemup`, builds a venv, installs the systemd unit, installs the avahi mDNS advertisement, and starts the service. Re-runnable; safe to run again if you change something.

## 5. Seed config.json from your Windows machine (optional but recommended)

The Hue bridge pairing, device nicknames, rooms, fixtures, and layouts all live in `backend/config.json`, which is gitignored. Copy yours over so you don't have to re-pair the bridge and rebuild rooms:

```powershell
scp C:\repos\lightemup\backend\config.json lightemup:/home/pi/lightemup/backend/config.json
ssh lightemup 'sudo systemctl restart lightemup'
```

If the Hue bridge's IP differs on the Pi's view of the LAN (unlikely — same network), re-run pairing from the setup wizard at `http://lightemup.local:8420`.

## 6. Verify

- Open `http://lightemup.local:8420` from your phone or laptop.
- On the Pi: `sudo systemctl status lightemup` should show `active (running)`.
- Tail logs: `journalctl -u lightemup -f`.

## Day-to-day: deploy from Windows

After committing + pushing changes from Windows:

```powershell
ssh lightemup '~/lightemup/deploy/update.sh'
```

That pulls main, refreshes deps if `requirements.txt` changed, and restarts the service. ~3 seconds end-to-end.

## How auto-start works

- `lightemup.service` is a systemd unit with `Restart=on-failure` and `WantedBy=multi-user.target`. `systemctl enable` linked it into the boot target, so it starts after every reboot.
- `After=network-online.target` ensures WiFi is up before the app tries to discover Hue/Govee on the LAN.
- The service runs as user `pi` (not root) — the app binds port 8420 and uses UDP 4002, both unprivileged.

## Files in this directory

| File | Purpose |
|---|---|
| `install.sh` | First-time setup. Run once on the Pi. |
| `update.sh` | Deploy script. Run after every push. |
| `lightemup.service` | systemd unit (installed to `/etc/systemd/system/`). |
| `lightemup.avahi.service` | mDNS advertisement (installed to `/etc/avahi/services/`). |

## Troubleshooting

- **`ssh: Could not resolve hostname lightemup.local`** — your Windows machine isn't doing mDNS. Either install Bonjour Print Services (ships with iTunes / Apple's site) or use the Pi's IP from your router's DHCP table.
- **Govee devices not discovered** — check no other process on the Pi holds UDP 4002. `sudo ss -ulnp | grep 4002` should show only the lightemup python process.
- **Hue bridge pairing fails** — bridge must be on the same subnet as the Pi, and you must press the physical button within 30s of clicking pair.
- **Service won't start** — `journalctl -u lightemup -n 100` for the last 100 log lines.
- **Need to roll back** — `cd ~/lightemup && git log --oneline -10`, then `git reset --hard <sha> && sudo systemctl restart lightemup`.
