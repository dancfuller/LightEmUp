"""
Device discovery module for Hue Bridge (mDNS/UPnP) and Govee LAN devices (UDP multicast).
"""

import asyncio
import base64
import json
import socket
import struct
import httpx
from typing import Optional


# ─── Hue Bridge Discovery ───────────────────────────────────────────────────

async def discover_hue_bridge() -> list[dict]:
    """
    Discover Hue Bridges on the local network.
    Method 1: Philips cloud discovery endpoint (quick, reliable if internet available)
    Method 2: mDNS/UPnP fallback (TODO if needed)
    """
    bridges = []

    # Method 1: Philips discovery endpoint
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get("https://discovery.meethue.com/")
            if resp.status_code == 200:
                data = resp.json()
                for bridge in data:
                    bridges.append({
                        "id": bridge.get("id", "unknown"),
                        "ip": bridge.get("internalipaddress"),
                        "port": bridge.get("port", 443),
                    })
    except Exception as e:
        print(f"[Hue] Cloud discovery failed: {e}")

    # Method 2: SSDP/UPnP fallback
    if not bridges:
        bridges = await _ssdp_discover_hue()

    return bridges


async def _ssdp_discover_hue() -> list[dict]:
    """Fallback SSDP discovery for Hue Bridge."""
    bridges = []
    SSDP_ADDR = "239.255.255.250"
    SSDP_PORT = 1900
    SEARCH_TARGET = "ssdp:all"

    message = (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {SSDP_ADDR}:{SSDP_PORT}\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 3\r\n"
        f"ST: {SEARCH_TARGET}\r\n"
        "\r\n"
    )

    loop = asyncio.get_event_loop()

    def _do_ssdp():
        found = []
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.settimeout(4)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.sendto(message.encode(), (SSDP_ADDR, SSDP_PORT))

        try:
            while True:
                data, addr = sock.recvfrom(4096)
                response = data.decode("utf-8", errors="ignore")
                if "hue" in response.lower() or "philips" in response.lower():
                    found.append({
                        "id": "ssdp-discovered",
                        "ip": addr[0],
                        "port": 443,
                    })
        except socket.timeout:
            pass
        finally:
            sock.close()
        return found

    try:
        bridges = await loop.run_in_executor(None, _do_ssdp)
    except Exception as e:
        print(f"[Hue] SSDP discovery failed: {e}")

    return bridges


async def get_hue_bridge_config(ip: str, username: Optional[str] = None) -> dict:
    """Get bridge configuration. If no username, returns basic info."""
    async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
        if username:
            resp = await client.get(f"https://{ip}/clip/v2/resource/light",
                                     headers={"hue-application-key": username})
            if resp.status_code == 200:
                return resp.json()
        # Basic config (no auth needed)
        resp = await client.get(f"http://{ip}/api/0/config")
        if resp.status_code == 200:
            return resp.json()
    return {}


async def pair_hue_bridge(ip: str, app_name: str = "lightemup", device_name: str = "server") -> Optional[str]:
    """
    Press the Hue Bridge button, then call this to create a username.
    Returns the username string on success, None on failure.
    """
    async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
        resp = await client.post(
            f"http://{ip}/api",
            json={"devicetype": f"{app_name}#{device_name}"}
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and len(data) > 0:
                if "success" in data[0]:
                    return data[0]["success"].get("username")
                if "error" in data[0]:
                    raise Exception(data[0]["error"].get("description", "Unknown error"))
    return None


async def get_hue_lights(ip: str, username: str) -> list[dict]:
    """Fetch all lights from the Hue Bridge using the v1 API."""
    async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
        resp = await client.get(f"http://{ip}/api/{username}/lights")
        if resp.status_code == 200:
            data = resp.json()
            lights = []
            for light_id, info in data.items():
                lights.append({
                    "id": light_id,
                    "name": info.get("name", f"Light {light_id}"),
                    "type": "hue",
                    "model": info.get("modelid", "unknown"),
                    "product_name": info.get("productname", ""),
                    "state": {
                        "on": info.get("state", {}).get("on", False),
                        "brightness": info.get("state", {}).get("bri", 0),
                        "hue": info.get("state", {}).get("hue"),
                        "saturation": info.get("state", {}).get("sat"),
                        "xy": info.get("state", {}).get("xy"),
                        "color_temp": info.get("state", {}).get("ct"),
                        "color_mode": info.get("state", {}).get("colormode"),
                        "reachable": info.get("state", {}).get("reachable", False),
                    },
                    "capabilities": {
                        "has_color": "colormode" in info.get("state", {}),
                        "has_color_temp": "ct" in info.get("state", {}),
                    },
                })
            return lights
    return []


async def get_hue_groups(ip: str, username: str) -> list[dict]:
    """Fetch all groups/rooms from the Hue Bridge."""
    async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
        resp = await client.get(f"http://{ip}/api/{username}/groups")
        if resp.status_code == 200:
            data = resp.json()
            groups = []
            for group_id, info in data.items():
                groups.append({
                    "id": group_id,
                    "name": info.get("name", f"Group {group_id}"),
                    "type": info.get("type", "Room"),
                    "light_ids": info.get("lights", []),
                    "state": {
                        "all_on": info.get("state", {}).get("all_on", False),
                        "any_on": info.get("state", {}).get("any_on", False),
                    },
                })
            return groups
    return []


async def set_hue_light_state(ip: str, username: str, light_id: str, state: dict) -> bool:
    """Set the state of a Hue light. state can include on, bri, hue, sat, ct, etc."""
    async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
        resp = await client.put(
            f"http://{ip}/api/{username}/lights/{light_id}/state",
            json=state
        )
        return resp.status_code == 200


# ─── Govee LAN Discovery ────────────────────────────────────────────────────

GOVEE_MULTICAST_ADDR = "239.255.255.250"
GOVEE_MULTICAST_PORT = 4001
GOVEE_LISTEN_PORT = 4002
GOVEE_COMMAND_PORT = 4003

GOVEE_SKU_NAMES = {
    "H70C1": "Christmas String Lights 2",
    "H7065": "Outdoor Spotlights 2-Pack",
    "H7066": "Outdoor Spotlights 4-Pack",
    "H6061": "Glide Hexa Light Panels",
    "H61D3": "Neon Rope Light 2",
}


async def discover_govee_lan(timeout: float = 5.0) -> list[dict]:
    """
    Discover Govee devices on the LAN via UDP broadcast.
    Govee devices with LAN control enabled respond to a scan message.
    """
    loop = asyncio.get_event_loop()

    def _do_scan():
        devices = []
        scan_message = json.dumps({
            "msg": {
                "cmd": "scan",
                "data": {
                    "account_topic": "reserve"
                }
            }
        })

        # Send via broadcast
        send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        send_sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        send_sock.settimeout(timeout)

        # Listen on port 4002
        recv_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        recv_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        recv_sock.settimeout(timeout)

        try:
            recv_sock.bind(("", GOVEE_LISTEN_PORT))
        except OSError:
            recv_sock.bind(("", 0))

        # Send scan via broadcast to port 4001
        send_sock.sendto(scan_message.encode(), ("255.255.255.255", GOVEE_MULTICAST_PORT))

        # Listen for responses
        seen_ips = set()
        try:
            while True:
                data, addr = recv_sock.recvfrom(4096)
                if addr[0] in seen_ips:
                    continue
                seen_ips.add(addr[0])

                try:
                    response = json.loads(data.decode("utf-8"))
                    msg = response.get("msg", {})
                    if msg.get("cmd") == "scan":
                        dev_data = msg.get("data", {})
                        sku = dev_data.get("sku", "unknown")
                        devices.append({
                            "ip": dev_data.get("ip", addr[0]),
                            "device": dev_data.get("device", "unknown"),
                            "mac": dev_data.get("device", "unknown"),
                            "sku": sku,
                            "type": "govee",
                            "name": GOVEE_SKU_NAMES.get(sku, sku),
                            "capabilities": {
                                "has_color": True,
                                "has_brightness": True,
                                "has_segments": False,
                            },
                        })
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
        except socket.timeout:
            pass
        finally:
            send_sock.close()
            recv_sock.close()

        return devices

    try:
        devices = await loop.run_in_executor(None, _do_scan)
    except Exception as e:
        print(f"[Govee] LAN discovery failed: {e}")
        devices = []

    return devices


async def govee_lan_command(ip: str, cmd: str, data: dict) -> Optional[dict]:
    """Send a command to a Govee device over LAN."""
    loop = asyncio.get_event_loop()

    def _send():
        message = json.dumps({
            "msg": {
                "cmd": cmd,
                "data": data
            }
        })
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(3.0)
        sock.sendto(message.encode(), (ip, GOVEE_COMMAND_PORT))
        try:
            resp_data, _ = sock.recvfrom(4096)
            return json.loads(resp_data.decode("utf-8"))
        except socket.timeout:
            return None
        finally:
            sock.close()

    return await loop.run_in_executor(None, _send)


async def govee_lan_turn(ip: str, on: bool) -> Optional[dict]:
    """Turn a Govee device on or off."""
    return await govee_lan_command(ip, "turn", {"value": 1 if on else 0})


async def govee_lan_brightness(ip: str, brightness: int) -> Optional[dict]:
    """Set brightness (0-100) of a Govee device."""
    return await govee_lan_command(ip, "brightness", {"value": max(0, min(100, brightness))})


async def govee_lan_color(ip: str, r: int, g: int, b: int) -> Optional[dict]:
    """Set RGB color of a Govee device."""
    return await govee_lan_command(ip, "colorwc", {
        "color": {"r": r, "g": g, "b": b},
        "colorTemInKelvin": 0
    })


async def govee_lan_color_temp(ip: str, kelvin: int) -> Optional[dict]:
    """Set color temperature of a Govee device."""
    return await govee_lan_command(ip, "colorwc", {
        "color": {"r": 0, "g": 0, "b": 0},
        "colorTemInKelvin": kelvin
    })


async def govee_lan_get_state(ip: str) -> Optional[dict]:
    """Query a Govee device's current state via LAN."""
    loop = asyncio.get_event_loop()

    def _query():
        message = json.dumps({"msg": {"cmd": "devStatus", "data": {}}})
        send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        send_sock.settimeout(2.0)
        recv_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        recv_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        recv_sock.settimeout(2.0)
        try:
            recv_sock.bind(("", GOVEE_LISTEN_PORT))
            send_sock.sendto(message.encode(), (ip, GOVEE_COMMAND_PORT))
            resp_data, _ = recv_sock.recvfrom(4096)
            resp = json.loads(resp_data.decode("utf-8"))
            if resp.get("msg", {}).get("cmd") == "devStatus":
                data = resp["msg"].get("data", {})
                return {
                    "on": data.get("onOff", 0) == 1,
                    "brightness": data.get("brightness", 0),
                    "color": data.get("color", {}),
                    "color_temp": data.get("colorTemInKelvin", 0),
                }
        except (socket.timeout, OSError):
            pass
        finally:
            send_sock.close()
            recv_sock.close()
        return None

    return await loop.run_in_executor(None, _query)


# ─── Govee Razer Protocol (Per-Segment) ──────────────────────────────────

GOVEE_SEGMENT_INFO = {
    "H6061": {"count": 7, "protocol": "razer", "name": "Glide Hexa Light Panels"},
    "H7065": {"count": 2, "protocol": "unknown", "name": "Outdoor Spotlights 2-Pack"},
    "H7066": {"count": 4, "protocol": "unknown", "name": "Outdoor Spotlights 4-Pack"},
    "H70C1": {"count": None, "protocol": "unknown", "name": "Christmas String Lights 2"},
    "H61D3": {"count": None, "protocol": "unknown", "name": "Neon Rope Light 2"},
}


def _build_razer_packet(command_byte: int, data: bytes) -> str:
    """Build a Razer protocol packet and return its base64-encoded string.

    Binary format: {0xBB, 0x00, data_size, command_byte, data..., checksum}
    - data_size = len(data) + 1 (includes the command byte)
    - Checksum = XOR of ALL preceding bytes in the packet
    """
    data_size = len(data) + 1
    packet = bytes([0xBB, 0x00, data_size, command_byte]) + data
    checksum = 0
    for b in packet:
        checksum ^= b
    packet += bytes([checksum])
    return base64.b64encode(packet).decode("ascii")


async def _govee_lan_send(ip: str, cmd: str, data: dict) -> None:
    """Send a command to a Govee device without waiting for response."""
    loop = asyncio.get_event_loop()

    def _send():
        message = json.dumps({"msg": {"cmd": cmd, "data": data}})
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.sendto(message.encode(), (ip, GOVEE_COMMAND_PORT))
        finally:
            sock.close()

    await loop.run_in_executor(None, _send)


async def govee_razer_enable(ip: str) -> None:
    """Enable Razer mode on a Govee device (fire-and-forget)."""
    packet_b64 = _build_razer_packet(0xB1, b'\x01')
    await _govee_lan_send(ip, "razer", {"pt": packet_b64})


async def govee_razer_disable(ip: str) -> None:
    """Disable Razer mode on a Govee device (fire-and-forget)."""
    packet_b64 = _build_razer_packet(0xB1, b'\x00')
    await _govee_lan_send(ip, "razer", {"pt": packet_b64})


async def govee_razer_set_segments(ip: str, colors: list[tuple[int, int, int]]) -> None:
    """Set per-segment colors via the Razer protocol (fire-and-forget).

    colors: list of (R, G, B) tuples, one per segment.
    """
    data = bytes([0x00, len(colors)])
    for r, g, b in colors:
        data += bytes([r, g, b])
    packet_b64 = _build_razer_packet(0xB0, data)
    await _govee_lan_send(ip, "razer", {"pt": packet_b64})


def govee_get_segment_info(sku: str) -> dict | None:
    """Look up segment info for a Govee SKU. Returns the dict or None."""
    return GOVEE_SEGMENT_INFO.get(sku)


# ─── Govee Cloud API (fallback) ─────────────────────────────────────────────

GOVEE_API_BASE = "https://developer-api.govee.com/v1"


async def govee_cloud_get_devices(api_key: str) -> list[dict]:
    """Fetch all devices from the Govee Cloud API."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{GOVEE_API_BASE}/devices",
            headers={"Govee-API-Key": api_key}
        )
        if resp.status_code == 200:
            data = resp.json()
            devices = data.get("data", {}).get("devices", [])
            return [{
                "device": d.get("device"),
                "model": d.get("model"),
                "name": d.get("deviceName", d.get("model", "Govee Device")),
                "type": "govee-cloud",
                "controllable": d.get("controllable", False),
                "retrievable": d.get("retrievable", False),
                "commands": [c.get("commandName") for c in d.get("supportCmds", [])],
            } for d in devices]
    return []
