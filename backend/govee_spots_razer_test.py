# govee_spots_razer_test.py
# ========================
#
# Interactive test for per-segment color control on Govee outdoor spotlights
# using the undocumented "Razer" protocol over LAN UDP.
#
# PURPOSE:
#   Determines whether the H7065 (2-pack) and H7066 (4-pack) outdoor
#   spotlights support the same Razer per-segment protocol that works on the
#   H6061 Hexa Panels.  Each spotlight in a pack is expected to be an
#   independently addressable segment.
#
# TEST RESULT:
#   NEGATIVE — Neither the H7065 nor the H7066 responded to Razer protocol
#   commands.  The lights remained unchanged.  These devices likely require
#   the ptReal (BLE-over-LAN) protocol for per-segment control instead.
#
# PROTOCOL:
#   Same Razer binary protocol as govee_razer_test.py — see that file's
#   header for full documentation.  In brief:
#     - UDP to port 4003, JSON envelope with base64 binary payload
#     - 0xB1 to enable/disable Razer mode
#     - 0xB0 to set per-segment colors
#
# PREREQUISITES:
#   - Spotlight devices powered on and connected to your LAN
#   - LAN Control enabled in the Govee Home app for each device
#   - Update the IP addresses in the DEVICES dict below to match your network
#
# USAGE:
#   python govee_spots_razer_test.py

import socket
import json
import base64
import time

COMMAND_PORT = 4003

# Device inventory — update IPs to match your network
DEVICES = {
    "Outdoor Spots 2pk": {"ip": "192.168.0.229", "sku": "H7065", "expected": 2},
    "Outdoor Spots 4pk": {"ip": "192.168.0.209", "sku": "H7066", "expected": 4},
}


# ─── Razer Protocol Helpers ──────────────────────────────────────────────────
# These are identical to govee_razer_test.py.  Duplicated here so each test
# script is fully self-contained and can be run independently.


def xor_checksum(data):
    """Compute XOR checksum across all bytes."""
    result = 0
    for b in data:
        result ^= b
    return result


def build_razer_packet(command, data):
    """Build a Razer protocol binary packet.

    Format: {0xBB, 0x00, data_size, command, data..., checksum}
    See govee_razer_test.py for full protocol documentation.
    """
    data_size = len(data) + 1
    packet = bytes([0xBB, 0x00, data_size, command]) + bytes(data)
    checksum = xor_checksum(packet)
    packet += bytes([checksum])
    return packet


def send_razer(ip, packet):
    """Send a Razer protocol command via UDP to the device."""
    b64 = base64.b64encode(packet).decode("utf-8")
    message = json.dumps({"msg": {"cmd": "razer", "data": {"pt": b64}}})
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(message.encode(), (ip, COMMAND_PORT))
    sock.close()


def enable_razer(ip):
    """Enable Razer per-segment mode (command 0xB1, data 0x01)."""
    send_razer(ip, build_razer_packet(0xB1, [1]))


def disable_razer(ip):
    """Disable Razer mode (command 0xB1, data 0x00)."""
    send_razer(ip, build_razer_packet(0xB1, [0]))


def set_led_colors(ip, colors, gradient=False):
    """Set per-segment colors (command 0xB0).

    Args:
        ip:       Device IP address.
        colors:   List of (R, G, B) tuples, one per segment.
        gradient: If True, colors are interpolated across segments.
    """
    data = [1 if gradient else 0, len(colors)]
    for r, g, b in colors:
        data.extend([r, g, b])
    send_razer(ip, build_razer_packet(0xB0, data))


def turn_on(ip):
    """Turn device on via standard Govee LAN command."""
    message = json.dumps({"msg": {"cmd": "turn", "data": {"value": 1}}})
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(message.encode(), (ip, COMMAND_PORT))
    sock.close()


# ─── Test Sequence ───────────────────────────────────────────────────────────
# Runs the same protocol sequence on each device: power on, enable Razer,
# send distinct colors (one per spotlight), test gradient, reset, and disable.

# Named test colors — we pick the first N for each device based on its
# expected segment count (2 for H7065, 4 for H7066)
colors = [
    ("Red",     255, 0,   0),
    ("Green",   0,   255, 0),
    ("Blue",    0,   0,   255),
    ("Yellow",  255, 255, 0),
]

for name, info in DEVICES.items():
    ip = info["ip"]
    expected = info["expected"]

    print("=" * 60)
    print(f"{name} ({info['sku']}) at {ip}")
    print(f"Expected segments: {expected}")
    print("=" * 60)

    # Step 1: Power on via standard LAN command
    print(f"\n[1] Turning on...")
    turn_on(ip)
    time.sleep(1)

    # Step 2: Enable Razer per-segment mode
    print(f"[2] Enabling Razer protocol...")
    enable_razer(ip)
    time.sleep(0.5)

    # Step 3: Assign a different color to each spotlight
    #         Uses only as many colors as the device has segments
    test_colors = [(r, g, b) for _, r, g, b in colors[:expected]]
    color_names = [c[0] for c in colors[:expected]]
    print(f"[3] Sending {expected} discrete colors: {', '.join(color_names)}")
    set_led_colors(ip, test_colors, gradient=False)

    input(f"\n>>> Look at {name} - does each spot have a different color? Press Enter...")

    # Step 4: Test gradient mode — interpolate red to blue across all spots
    print(f"[4] Testing gradient: Red to Blue across {expected} spots...")
    set_led_colors(ip, [(255, 0, 0), (0, 0, 255)], gradient=True)

    input(f"\n>>> Do you see a gradient from red to blue? Press Enter...")

    # Step 5: Reset all spots to white
    print(f"[5] Resetting to white...")
    set_led_colors(ip, [(255, 255, 255)] * expected, gradient=False)
    time.sleep(1)

    # Step 6: Exit Razer mode — device returns to normal operation
    print(f"[6] Disabling Razer protocol...")
    disable_razer(ip)

    print()

print("Done!")
