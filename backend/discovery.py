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
    # Sources for Govee SKU-to-name lookups:
    #   - FCC ID filings (fccid.io/2AQA6, fccid.io/2A7VD) — best for newer products
    #   - Govee Developer API model list (developer.govee.com/docs/support-product-model)
    #   - Govee website product pages (us.govee.com, eu.govee.com)
    #   - homebridge-govee supported devices wiki (github.com/homebridge-plugins/homebridge-govee)
    #   - Amazon/retailer product listings
    #
    # Smart Bulbs
    "H6002": "Smart LED Bulb",
    "H6003": "Smart LED Bulb",
    "H6004": "Smart LED Bulb",
    "H6006": "Smart LED Bulb 1000LM",
    "H6008": "Smart LED Bulb 2-Pack",
    "H6009": "Smart LED Bulb RGBWW",
    "H600A": "Smart LED Night Light Bulb",
    "H600B": "Smart Bulb",
    "H600D": "Smart Bulb",
    "H6010": "Smart LED Bulb",
    "H6011": "Smart LED Bulb RGBWW",
    "H6013": "Smart Bulb",
    # Recessed Lighting
    "H601A": "Smart RGBWW Recessed Light 6in 4-Pack",
    "H601B": "Smart Recessed Light 4in",
    "H601C": "Smart Retrofit Recessed Light 6in",
    "H601D": "Smart Recessed Light 4in",
    # Table Lamps / Desk Lamps
    "H6020": "RGBIC Table Lamp",
    "H6022": "Smart Table Lamp 2",
    "H6038": "Wall Sconce 2-Pack",
    "H6039": "Wall Sconce",
    # TV Light Bars
    "H6042": "TV Light Bar 2",
    "H6043": "TV Light Bars 2",
    "H6046": "RGBIC TV Light Bars",
    "H6047": "RGBIC Gaming Light Bars with Smart Controller",
    "H6049": "Flow Pro TV Light Bar",
    "H604A": "DreamView G1S Pro Gaming Light",
    "H604B": "DreamView G1 Gaming Light",
    "H604C": "DreamView Gaming Light",
    "H604D": "DreamView Gaming Light",
    # Table / Floor Lamps
    "H6050": "Glow Table Lamp",
    "H6051": "Aura Smart Table Lamp",
    "H6052": "Table Lamp",
    "H6054": "Envisual TV Backlight",
    "H6056": "Flow Plus Light Bar",
    "H6057": "Envisual TV Backlight",
    "H6058": "Envisual TV Backlight",
    "H6059": "RGBWW Night Light for Kids",
    "H605A": "TV Backlight 3 Lite Kit",
    "H605B": "DreamView T1 Pro TV Backlight",
    "H605C": "Envisual TV Backlight T2",
    "H605D": "RGBICWW TV Light Kit",
    # Wall / Panel Lights
    "H6061": "Glide Hexa Light Panels",
    "H6062": "Glide Wall Light",
    "H6063": "Gaming Wall Light",
    "H6065": "Glide RGBIC Y Lights",
    "H6066": "Glide Hexa Pro LED Panel",
    "H6067": "Glide Triangle Light Panels",
    "H6069": "Mini Panel Lights",
    "H606A": "Glide Hexa Light Panels Ultra",
    # Floor Lamps
    "H6071": "RGBIC Floor Lamp",
    "H6072": "RGBICWW Corner Floor Lamp",
    "H6073": "LED Floor Lamp",
    "H6075": "RGBIC Smart Corner Floor Lamp",
    "H6076": "RGBICW Smart Corner Floor Lamp Basic",
    "H6078": "Cylinder Floor Lamp",
    "H6079": "RGBICWW Floor Lamp Pro",
    "H607C": "Floor Lamp 2",
    # Wall Sconces
    "H6085": "RGBIC Smart Wall Sconces",
    "H6086": "RGBIC Smart Wall Sconces",
    "H6087": "RGBIC Smart Wall Sconces",
    "H6088": "RGBIC Cube Wall Sconces",
    "H6089": "RGBIC Wall Sconces",
    # String Downlights / Ceiling
    "H608A": "String Downlights 5M",
    "H608B": "String Downlights 3M",
    "H608C": "String Downlights 2M",
    "H608D": "String Downlights 10M",
    "H60A0": "Ceiling Light",
    "H60A1": "Smart Ceiling Light",
    "H60A4": "Square Ceiling Light",
    "H60A6": "Ceiling Light Pro",
    "H60B0": "Uplighter Floor Lamp",
    # Projectors
    "H6091": "Star Projector",
    "H6092": "Star Light Projector",
    "H6093": "Aurora Star Light Projector",
    # TV Backlights
    "H6097": "TV Backlight 3 Lite 40-50in",
    "H6098": "TV Backlight 3 Lite 75-85in",
    "H6099": "TV Backlight 3 Lite 55-65in",
    "H6167": "TV Backlight 2.4M",
    "H6168": "TV Backlight",
    "H6169": "TV Backlight 70-80in",
    "H6181": "RGB LED TV Backlight Strip",
    "H6182": "WiFi Multicolor TV Strip Light",
    "H6195": "DreamView TV Backlight",
    "H6198": "Immersion RGBIC TV Backlight",
    "H6199": "DreamView T1 TV Backlight",
    # Glide / Wall Lights
    "H6104": "Glide Lively Wall Light",
    "H6109": "RGBIC LED Strip Light",
    "H610A": "Glide Lively Wall Lights",
    "H610B": "Music Wall Lights",
    # LED Strip Lights (Indoor)
    "H6110": "Multicolor Strip Light 2x5M",
    "H611A": "RGBIC Pro LED Strip Light",
    "H611B": "RGBIC LED Strip Light",
    "H611Z": "RGBIC LED Strip Light",
    "H6117": "Dream Color LED Strip Light 10M",
    "H6121": "RGB LED Strip Light",
    "H612A": "Strip Light S 5M",
    "H612B": "Strip Light S",
    "H612C": "Strip Light S 10M",
    "H612D": "Strip Light S",
    "H612E": "Strip Light S",
    "H612F": "Strip Light S",
    "H6135": "RGB LED Strip Light",
    "H6137": "RGB LED Strip Light",
    "H613G": "RGB LED Strip Light",
    "H6141": "Smart Multicolor Strip Light 5M",
    "H6142": "RGB LED Strip Light",
    "H6143": "Strip Light 5M",
    "H6144": "Strip Light 2x5M",
    "H6148": "RGB LED Strip Light",
    "H6149": "RGB LED Strip Light",
    "H614A": "RGB LED Strip Light",
    "H614B": "RGB LED Strip Light",
    "H614C": "RGB LED Strip Light",
    "H614E": "RGB LED Strip Light",
    "H6154": "RGB LED Strip Light",
    "H6159": "RGB Light Strip",
    "H615A": "Light Strip with Alexa 5M",
    "H615B": "Light Strip with Alexa 10M",
    "H615C": "Light Strip with Alexa 15M",
    "H615D": "Light Strip with Alexa 20M",
    "H615E": "Light Strip with Alexa 30M",
    "H6160": "RGBIC LED Strip Light",
    "H6163": "Dreamcolor LED Strip Light 5M",
    "H6170": "RGBIC Outdoor LED Strip Light",
    "H6178": "RGBIC LED Strip Light",
    "H618A": "RGBIC Basic LED Strip Lights 5M",
    "H618C": "RGBIC Basic LED Strip Lights 5M",
    "H618E": "LED Strip Lights 22M",
    "H618F": "RGBIC LED Strip Lights",
    # DreamView / Immersion / Protective Coating Strip Lights
    "H619A": "Strip Lights with Protective Coating 5M",
    "H619B": "Strip Lights with Protective Coating 7.5M",
    "H619C": "Strip Lights with Protective Coating 10M",
    "H619D": "PRO LED Strip Lights 2x7.5M",
    "H619E": "Strip Lights with Protective Coating 2x10M",
    "H619Z": "Pro LED Strip Lights 3M",
    # Neon Rope Lights
    "H61A0": "RGBIC Neon Rope Light 3M",
    "H61A1": "RGBIC Neon Rope Light 2M",
    "H61A2": "RGBIC Neon Rope Light 5M",
    "H61A3": "RGBIC Neon Rope Light 4M",
    "H61A5": "Neon LED Strip Light 10M",
    "H61A8": "Neon Rope Light 10M",
    "H61A9": "Outdoor Neon Rope Light",
    "H61B1": "Strip Light with Cover 5M",
    "H61B2": "RGBIC Neon TV Backlight 3M",
    "H61B3": "RGBIC LED Strip Light with Covers",
    "H61B5": "RGBIC LED Strip Light with Covers",
    "H61B6": "RGBIC LED Strip Light with Covers",
    "H61B8": "Strip Light with Skyline Kit",
    "H61BA": "LED Strip Light 5M",
    "H61BC": "LED Strip Light 10M",
    "H61BE": "LED Strip Light 2x10M",
    "H61C2": "Neon LED Strip Light",
    "H61C3": "RGBIC LED Neon Rope Light for Desks",
    "H61C5": "RGBIC LED Neon Rope Light for Desks",
    "H61D3": "Neon Rope Light 2",
    "H61D5": "Neon Rope Light 2 5M",
    # Strip Light Pro / M1 / COB
    "H61E0": "LED Strip Light M1",
    "H61E1": "LED Strip Light M1",
    "H61E5": "COB Strip Light Pro 3M",
    "H61E6": "COB Strip Light Pro 5M",
    "H61F2": "Neon Rope Light 2",
    "H61F5": "Strip Light 2 Pro",
    "H61F6": "Strip Light 2 Pro",
    # Outdoor Strip Lights
    "H616C": "Outdoor Strip 10M",
    "H616D": "Outdoor Strip Light Evo",
    "H616E": "Outdoor Strip 2x10M",
    "H6172": "Outdoor LED Strip 10M",
    "H6173": "RGBIC Outdoor Strip Lights",
    "H6175": "RGBIC Outdoor Strip Lights 10M",
    "H6176": "RGBIC Outdoor Strip Lights 30M",
    # Entertainment / AI Sync
    "H6601": "TV Box Light",
    "H6602": "TV Box Light",
    "H6603": "AI Sync Box Kit 2",
    "H6604": "TV Box Light",
    "H6608": "AI Sync Box",
    "H6609": "Envisual TV Backlight T2",
    "H6611": "AI Sync Box",
    "H6630": "Gaming Pixel Light",
    "H6631": "Gaming Pixel Light",
    "H6640": "Neon Rope Light for Wall Lining",
    "H6641": "Neon Rope Light for Wall Lining 5M",
    # Christmas / Seasonal
    "H6800": "Christmas Tree Lights",
    "H6810": "Net Lights",
    "H6811": "Outdoor Net Lights",
    "H6820": "Christmas Sparkle String Lights",
    "H6821": "Christmas Sparkle String Lights",
    "H6822": "Christmas Sparkle String Lights",
    "H6840": "Cone Tree Lights",
    # Outdoor String Lights
    "H7005": "Outdoor String Lights",
    "H7007": "Outdoor String Lights",
    "H7008": "Outdoor String Lights",
    "H7012": "Warm White Outdoor String Lights",
    "H7013": "Warm White Outdoor String Lights",
    "H7014": "Smart Outdoor Plug",
    "H7020": "RGBIC Warm White Outdoor String Lights",
    "H7021": "RGBIC Warm White Smart Outdoor String Lights",
    "H7022": "RGBIC Outdoor String Lights",
    "H7025": "Outdoor Clear Bulb String Lights",
    "H7028": "Lynx Dream LED-Bulb String",
    "H7031": "RGBIC Smart Wall Light",
    "H7032": "RGBIC Smart Wall Light",
    "H7033": "LED-Bulb String Lights",
    "H7037": "Outdoor String Lights 2",
    "H7038": "Outdoor String Lights 2",
    "H7039": "Outdoor String Lights 2",
    "H703A": "Outdoor Dots String Lights",
    "H703B": "Outdoor Dots String Lights",
    "H7041": "LED Outdoor Bulb String Lights",
    "H7042": "LED Outdoor Bulb String Lights",
    "H702C": "Outdoor S14 Bulb String Lights 2",
    # Outdoor Ground / Pathway Lights
    "H7050": "Outdoor Ground Lights 11M",
    "H7051": "Outdoor Ground Lights 15M",
    "H7052": "Outdoor Ground Lights",
    "H7053": "Outdoor Ground Lights 2 100ft",
    "H7055": "Pathway Light",
    "H7056": "Pathway Light",
    "H7057": "Outdoor Flood Lights 2",
    "H7058": "Outdoor Flood Lights 2",
    # Permanent Outdoor Lights
    "H705A": "Permanent Outdoor Lights 30M",
    "H705B": "Permanent Outdoor Lights 15M",
    "H705C": "Permanent Outdoor Lights 45M",
    "H705D": "Permanent Outdoor Lights 2 15M",
    "H705E": "Permanent Outdoor Lights 2 30M",
    "H705F": "Permanent Outdoor Lights 2 45M",
    "H706A": "Permanent Outdoor Lights Pro 30M",
    "H706B": "Permanent Outdoor Lights Pro 45M",
    "H706C": "Permanent Outdoor Lights Pro 60M",
    "H801B": "Smart RGBIC Permanent Lights",
    "H801C": "Smart RGBIC Permanent Lights",
    "H805A": "Permanent Outdoor Lights Elite 30M",
    "H805B": "Permanent Outdoor Lights Elite 15M",
    "H805C": "Permanent Outdoor Lights Elite 45M",
    # Flood Lights / Spot Lights
    "H7060": "LED Flood Lights 2-Pack",
    "H7061": "LED Flood Lights 4-Pack",
    "H7062": "LED Flood Lights 6-Pack",
    "H7063": "Triad Flood Light",
    "H7065": "Outdoor Spot Lights 2-Pack",
    "H7066": "Outdoor Spot Lights 4-Pack",
    "H7067": "Outdoor Deck Lights",
    "H7068": "Outdoor Deck Lights",
    "H7069": "Outdoor Deck Lights",
    # Other Outdoor
    "H7070": "Outdoor Projector Light",
    "H7072": "Outdoor Lamp Post Lights",
    "H7075": "Outdoor Wall Light",
    "H7078": "Smart Outdoor Wall Light",
    "H7086": "Outdoor Garden Lights",
    "H7093": "Outdoor Spotlights 2",
    # Outdoor Strip Lights Pro
    "H70A1": "Outdoor Strip Lights Pro",
    "H70A2": "Outdoor Strip Lights Pro",
    "H70A3": "Outdoor Strip Lights Pro",
    # Curtain Lights
    "H70B1": "520 LED Curtain Lights",
    "H70B3": "Curtain Lights 2 4.9x6.6ft",
    "H70B4": "Curtain Lights 2 9.8x6.6ft",
    "H70B5": "Curtain Lights 2 14.8x6.6ft",
    "H70BC": "400 LED Curtain Lights",
    # Christmas String Lights
    "H70C1": "Christmas String Lights 2 10M",
    "H70C2": "RGBIC String Light 20M",
    "H70C3": "Christmas String Lights 2",
    "H70C4": "Christmas String Lights 2 66ft",
    "H70C5": "Christmas String Lights 2 99ft",
    "H70C6": "Christmas String Lights 2",
    "H70C7": "Christmas String Lights 2 164ft",
    "H70C8": "Christmas String Lights 2",
    "H70C9": "Christmas String Lights 2 328ft",
    "H70CB": "Christmas String Lights",
    "H80C4": "Christmas String Lights 2S",
    # Icicle Lights
    "H70D1": "Icicle Lights 33ft",
    "H70D2": "Icicle Lights 66ft",
    "H70D3": "Icicle Lights",
    # Other H8xxx Outdoor
    "H8057": "Permanent Outdoor Lights",
    "H8069": "Outdoor Lights",
    "H8072": "Outdoor Lights",
    "H8076": "Outdoor Lights",
    "H807C": "Outdoor Lights",
    "H808A": "String Downlights",
    "H80D1": "Outdoor Lights",
    # Smart Home Sensors / Plugs (H5xxx)
    "H5001": "Smart Plug",
    "H5051": "Smart Plug",
    "H5071": "Smart Plug",
    "H5080": "Smart Plug",
    "H5081": "Smart Plug",
    "H5082": "Smart Plug",
    "H5083": "Smart Plug",
    "H5086": "Smart Plug",
    "H5100": "Thermo-Hygrometer",
    "H5103": "Thermo-Hygrometer",
    "H5127": "Thermo-Hygrometer",
    "H5160": "Smart Thermo-Hygrometer",
    "H5161": "Smart Thermo-Hygrometer",
    "H5179": "Smart Thermo-Hygrometer",
    # Appliances
    "H7100": "Smart Tower Fan",
    "H7101": "Smart Space Heater",
    "H7102": "Smart Tower Fan",
    "H7103": "Smart Tower Fan",
    "H7106": "Smart Tower Fan",
    "H7111": "Smart Fan",
    "H7112": "Smart Fan",
    "H7120": "Smart Air Purifier",
    "H7121": "Smart Air Purifier",
    "H7130": "Smart Air Purifier",
    "H7131": "Smart Air Purifier",
    "H713A": "Smart Air Purifier",
    "H7135": "Smart Air Purifier",
    "H7145": "Smart Humidifier 2 6L",
    "H7152": "Smart Dehumidifier Max",
    "H7160": "Smart Humidifier",
    "H7171": "Smart Kettle",
    "H7173": "Smart Kettle",
    "H717D": "Smart Countertop Ice Maker 1s",
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
    "H7065": {"count": 2, "protocol": "cloud_v2", "name": "Outdoor Spotlights 2-Pack"},
    "H7066": {"count": 4, "protocol": "cloud_v2", "name": "Outdoor Spotlights 4-Pack"},
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


# ─── Govee Platform API v2 (per-segment control) ────────────────────────────

GOVEE_V2_BASE = "https://openapi.api.govee.com/router/api/v1"


async def govee_v2_segment_color(api_key: str, sku: str, device_mac: str,
                                  segment_idx: int, r: int, g: int, b: int) -> bool:
    """Set a single segment's color via the Govee Platform API v2."""
    rgb_int = (r << 16) | (g << 8) | b
    payload = {
        "requestId": f"seg-{segment_idx}-{int(asyncio.get_event_loop().time() * 1000)}",
        "payload": {
            "sku": sku,
            "device": device_mac,
            "capability": {
                "type": "devices.capabilities.segment_color_setting",
                "instance": "segmentedColorRgb",
                "value": {"segment": [segment_idx], "rgb": rgb_int},
            },
        },
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{GOVEE_V2_BASE}/device/control",
            headers={"Govee-API-Key": api_key, "Content-Type": "application/json"},
            json=payload,
        )
        return resp.status_code == 200


async def govee_v2_segment_brightness(api_key: str, sku: str, device_mac: str,
                                       segment_idx: int, brightness: int) -> bool:
    """Set a single segment's brightness via the Govee Platform API v2."""
    payload = {
        "requestId": f"bri-{segment_idx}-{int(asyncio.get_event_loop().time() * 1000)}",
        "payload": {
            "sku": sku,
            "device": device_mac,
            "capability": {
                "type": "devices.capabilities.segment_color_setting",
                "instance": "segmentedBrightness",
                "value": {"segment": [segment_idx], "brightness": max(0, min(100, brightness))},
            },
        },
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{GOVEE_V2_BASE}/device/control",
            headers={"Govee-API-Key": api_key, "Content-Type": "application/json"},
            json=payload,
        )
        return resp.status_code == 200
