# govee_razer_test.py
# ===================
#
# Interactive test for per-segment color control on the Govee H6061 Glide Hexa
# Light Panels using the undocumented "Razer" protocol over LAN UDP.
#
# PURPOSE:
#   Validates that the Razer binary protocol can independently address each of
#   the 7 physical hex panels on an H6061 device.  The test walks through
#   discrete-color mode, gradient mode, under/over-count scenarios, and
#   cleanup — pausing at each step so you can visually confirm the result.
#
# PROTOCOL OVERVIEW:
#   Commands are sent as UDP datagrams to port 4003 on the device.  The payload
#   is JSON wrapping a base64-encoded binary packet:
#
#     {"msg": {"cmd": "razer", "data": {"pt": "<base64>"}}}
#
#   Binary packet format:
#     Byte 0:   0xBB (header)
#     Byte 1:   0x00 (reserved)
#     Byte 2:   data_size (length of command + data, excluding header/checksum)
#     Byte 3:   command byte (0xB1 = enable/disable, 0xB0 = set LEDs)
#     Byte 4+:  command-specific data
#     Last:     XOR checksum of all preceding bytes
#
#   Commands used:
#     0xB1 [0x01] — Enable Razer mode (device enters per-segment control mode)
#     0xB1 [0x00] — Disable Razer mode (device returns to normal)
#     0xB0 [gradient, count, R, G, B, ...] — Set segment colors
#       - gradient: 0 = discrete (one color per segment), 1 = interpolated
#       - count: number of RGB triplets that follow
#
# PREREQUISITES:
#   - H6061 device powered on and connected to your LAN
#   - LAN Control enabled in the Govee Home app
#   - Update HEXA_IP below to match your device's IP address
#
# USAGE:
#   python govee_razer_test.py
#
# TEST RESULTS (for reference):
#   - 7 discrete colors: WORKS — each panel shows its assigned color
#   - Gradient mode:     WORKS — smooth color transitions across panels
#   - 2 discrete colors: WORKS — panels split between the two colors
#   - 2 gradient colors: WORKS — smooth red-to-blue gradient
#   - 21 colors:         FAILS — device does not respond (max is 7 segments)

import socket
import json
import base64
import time

COMMAND_PORT = 4003
HEXA_IP = "192.168.0.129"  # <-- Update this to your H6061's IP address


# ─── Razer Protocol Helpers ──────────────────────────────────────────────────


def xor_checksum(data):
    """Compute XOR checksum across all bytes.

    The Razer protocol uses a single-byte XOR of every preceding byte in the
    packet as its integrity check.
    """
    result = 0
    for b in data:
        result ^= b
    return result


def build_razer_packet(command, data):
    """Build a complete Razer binary packet ready for base64 encoding.

    Args:
        command: Command byte (0xB1 for enable/disable, 0xB0 for LED data).
        data:    List of data bytes specific to the command.

    Returns:
        bytes: The assembled packet including header, size, command, data,
               and trailing XOR checksum.
    """
    data_size = len(data) + 1  # +1 because the command byte itself counts
    packet = bytes([0xBB, 0x00, data_size, command]) + bytes(data)
    checksum = xor_checksum(packet)
    packet += bytes([checksum])
    return packet


def send_razer(ip, packet):
    """Wrap a binary packet in JSON and send it to the device via UDP.

    The Govee LAN API expects a JSON envelope with the base64-encoded binary
    payload under msg.data.pt.
    """
    b64 = base64.b64encode(packet).decode("utf-8")
    message = json.dumps({
        "msg": {
            "cmd": "razer",
            "data": {"pt": b64}
        }
    })
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(message.encode(), (ip, COMMAND_PORT))
    sock.close()


def enable_razer(ip):
    """Enable Razer per-segment mode on the device.

    Sends command 0xB1 with data byte 0x01.  The device will stay in Razer
    mode for 60 seconds unless kept alive with LED data packets.
    """
    packet = build_razer_packet(0xB1, [1])
    send_razer(ip, packet)


def disable_razer(ip):
    """Disable Razer mode, returning the device to normal operation.

    Sends command 0xB1 with data byte 0x00.
    """
    packet = build_razer_packet(0xB1, [0])
    send_razer(ip, packet)


def set_led_colors(ip, colors, gradient=False):
    """Set per-segment colors on the device.

    Args:
        ip:       Device IP address.
        colors:   List of (R, G, B) tuples — one per segment (discrete mode)
                  or control points (gradient mode).
        gradient: If False, each color maps to one segment directly.
                  If True, colors are interpolated across the full strip.
    """
    data = [1 if gradient else 0, len(colors)]
    for r, g, b in colors:
        data.extend([r, g, b])
    packet = build_razer_packet(0xB0, data)
    send_razer(ip, packet)


def turn_on(ip):
    """Turn the device on using the standard Govee LAN command."""
    message = json.dumps({"msg": {"cmd": "turn", "data": {"value": 1}}})
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(message.encode(), (ip, COMMAND_PORT))
    sock.close()


# ─── Test Sequence ───────────────────────────────────────────────────────────

# 7 distinct colors — one for each hex panel on the H6061
colors_7 = [
    (255, 0,   0),    # Panel 1: Red
    (0,   255, 0),    # Panel 2: Green
    (0,   0,   255),  # Panel 3: Blue
    (255, 255, 0),    # Panel 4: Yellow
    (255, 0,   255),  # Panel 5: Magenta
    (0,   255, 255),  # Panel 6: Cyan
    (255, 128, 0),    # Panel 7: Orange
]

print("=" * 60)
print("Govee Razer Protocol Test - Hexa Panels (H6061)")
print(f"Target device IP: {HEXA_IP}")
print("=" * 60)

# Step 1: Power on the device via standard LAN command
print("\n[1] Turning on device...")
turn_on(HEXA_IP)
time.sleep(1)

# Step 2: Switch the device into Razer per-segment mode
print("[2] Enabling Razer protocol...")
enable_razer(HEXA_IP)
time.sleep(0.5)

# Step 3: Send 7 discrete colors — each panel should show a unique color
print("[3] Sending 7 discrete colors (one per panel)...")
print("    Red, Green, Blue, Yellow, Magenta, Cyan, Orange")
set_led_colors(HEXA_IP, colors_7, gradient=False)

input("\n>>> Look at the Hexa Panels - do you see 7 different colors? Press Enter...")

# Step 4: Same 7 colors in gradient mode — should blend smoothly across panels
print("\n[4] Testing gradient mode with same 7 colors...")
set_led_colors(HEXA_IP, colors_7, gradient=True)

input("\n>>> Do you see a gradient across the panels? Press Enter...")

# Step 5: Only 2 colors in discrete mode — tests how device handles fewer
#          colors than segments (does it repeat? leave remaining dark?)
print("\n[5] Testing with 2 colors: Red and Blue...")
set_led_colors(HEXA_IP, [(255, 0, 0), (0, 0, 255)], gradient=False)

input("\n>>> What do you see? Press Enter...")

# Step 6: 2 colors in gradient mode — should smoothly transition red to blue
print("\n[6] Testing 2 colors gradient: Red to Blue...")
set_led_colors(HEXA_IP, [(255, 0, 0), (0, 0, 255)], gradient=True)

input("\n>>> What do you see? Press Enter...")

# Step 7: Stress test with 21 colors — govee2mqtt reports H6061 as having
#          segments 0..21, but in practice only 7 physical panels exist.
#          This test confirms whether the device accepts more than 7 segments.
print("\n[7] Testing with 21 colors (govee2mqtt says H6061 has segments 0..21)...")
colors_21 = []
for i in range(21):
    # Generate a rainbow by stepping through HSV hue at full saturation/value
    hue = i / 21
    h = hue * 6
    x = 1 - abs(h % 2 - 1)
    if h < 1:   r, g, b = 1, x, 0
    elif h < 2: r, g, b = x, 1, 0
    elif h < 3: r, g, b = 0, 1, x
    elif h < 4: r, g, b = 0, x, 1
    elif h < 5: r, g, b = x, 0, 1
    else:       r, g, b = 1, 0, x
    colors_21.append((int(r * 255), int(g * 255), int(b * 255)))
set_led_colors(HEXA_IP, colors_21, gradient=False)

input("\n>>> What do you see with 21 colors? Press Enter...")

# Step 8: Reset all panels to white before exiting
print("\n[8] Resetting to white...")
set_led_colors(HEXA_IP, [(255, 255, 255)] * 7, gradient=False)
time.sleep(1)

# Step 9: Exit Razer mode — device resumes whatever mode it was in before
print("[9] Disabling Razer protocol (device returns to normal mode)...")
disable_razer(HEXA_IP)

print("\nDone!")
