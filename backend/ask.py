"""Ask — natural-language control of the house (v3.60.0).

You type (or dictate with the phone keyboard's mic) "make the living room spooky
but leave the hexa alone"; Claude Haiku 4.5 turns that into calls to a short,
fixed list of LightEmUp actions; the Pi validates and runs them through the same
code paths the buttons use, and answers in one sentence.

WHAT THIS MODULE IS, AND ISN'T
------------------------------
This module never touches a device. It owns the conversation with the model:
the system prompt, the tool (action) definitions, the loop, a few minutes of
per-browser memory so "which lamp?" / "the left one" works, the daily cap and
the cost tally. `main.py` hands it the actions as plain async functions, which
keeps every light command on the paths the rest of the app already trusts (and
lets the tests drive this with a fake model and fake actions).

THE TWO RULES THE CODE ENFORCES (not left to the model)
-------------------------------------------------------
1. House-wide changes need a yes. An action aimed at "house" is refused the
   first time with a note telling the model to ask; it runs only when the model
   repeats exactly that action with `confirmed: true` AFTER the user has
   answered. A model that sets `confirmed` on its own first try gets refused.
2. A daily cap (DAILY_CAP requests), so a loop or a stuck client can't run up a
   bill. A request is about 1–2 cents on Haiku 4.5: two model calls over a
   ~5.5k-token prompt, most of it the exact palette / team / flag names.
"""

import json
import logging
import time
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger("lightemup.ask")

MODEL = "claude-haiku-4-5"
MAX_TOKENS = 1024
MAX_STEPS = 6              # model calls per request (tool round-trips)
CONVO_TTL_S = 180          # a follow-up within this long continues the conversation
CONVO_MAX_MESSAGES = 24
DAILY_CAP = 200
# Claude Haiku 4.5, US$ per million tokens: input, output, cache write, cache read.
PRICE = {"in": 1.00, "out": 5.00, "cache_write": 1.25, "cache_read": 0.10}

HOUSE = "house"
HOUSE_WIDE_TOOLS = {"set_power", "set_white", "set_color", "set_brightness", "apply_palette"}


class AskError(Exception):
    """A request the action can't carry out as asked — the message goes back to
    the model as an error result, so it can ask the user or try again."""


# ─── The actions the model may use ──────────────────────────────────────────
_TARGETS = {
    "type": "array", "minItems": 1, "items": {"type": "string"},
    "description": "Room or zone names exactly as listed, or \"house\" for every room.",
}
_CONFIRMED = {
    "type": "boolean",
    "description": "Only true when repeating a house-wide action the user just confirmed.",
}
_RGB = {
    "red": {"type": "integer", "minimum": 0, "maximum": 255},
    "green": {"type": "integer", "minimum": 0, "maximum": 255},
    "blue": {"type": "integer", "minimum": 0, "maximum": 255},
}
_BRIGHTNESS = {"type": "integer", "minimum": 1, "maximum": 100, "description": "Percent."}


def _tool(name, description, properties, required):
    return {"name": name, "description": description,
            "input_schema": {"type": "object", "properties": properties,
                             "required": required, "additionalProperties": False}}


def build_tools(mode_keys: list) -> list:
    return [
        _tool("set_power", "Turn rooms on or off. Turning ON only resumes each light's "
              "last state — for 'turn the lights on' use set_white instead.",
              {"targets": _TARGETS, "on": {"type": "boolean"},
               "except_rooms": {"type": "array", "items": {"type": "string"},
                                "description": "Rooms to leave alone (with targets=[\"house\"])."},
               "confirmed": _CONFIRMED},
              ["targets", "on"]),
        _tool("set_white", "Set rooms to a white. 2700 is incandescent/soft white, 6500 cool daylight.",
              {"targets": _TARGETS,
               "kelvin": {"type": "integer", "minimum": 2000, "maximum": 6500},
               "brightness": _BRIGHTNESS, "confirmed": _CONFIRMED},
              ["targets", "kelvin", "brightness"]),
        _tool("set_color", "Set every light in rooms to one solid color.",
              {"targets": _TARGETS, **_RGB, "brightness": _BRIGHTNESS, "confirmed": _CONFIRMED},
              ["targets", "red", "green", "blue"]),
        _tool("set_brightness", "Change the brightness of rooms without changing their colors.",
              {"targets": _TARGETS, "brightness": _BRIGHTNESS, "confirmed": _CONFIRMED},
              ["targets", "brightness"]),
        _tool("apply_palette", "Spread a multi-color look across rooms. Give exactly one of: "
              "palette (an exact palette name), category (a random palette from that "
              "category), or preset (an exact team, college or country name).",
              {"targets": _TARGETS, "palette": {"type": "string"},
               "category": {"type": "string"}, "preset": {"type": "string"},
               "brightness": _BRIGHTNESS, "confirmed": _CONFIRMED},
              ["targets"]),
        _tool("start_light_show", "Start a light show in a room, or switch the mode of one "
              "that's already running. Handles a room that's off by itself.",
              {"room": {"type": "string"},
               "mode": {"type": "string", "enum": list(mode_keys)}},
              ["room"]),
        _tool("stop_light_show", "Stop a light show. Omit room when only one is running.",
              {"room": {"type": "string"}}, []),
        _tool("exclude_lights", "Exclude lights from (or return them to) their room's looks. "
              "Excluded lights keep what they're showing when the room's look changes.",
              {"room": {"type": "string"},
               "lights": {"type": "array", "minItems": 1, "items": {"type": "string"}},
               "excluded": {"type": "boolean"}},
              ["room", "lights", "excluded"]),
        _tool("release_exclusions", "Return every excluded light in a room to following it.",
              {"room": {"type": "string"}}, ["room"]),
        _tool("control_light", "Control ONE light by its exact name.",
              {"light": {"type": "string"}, "on": {"type": "boolean"}, **_RGB,
               "kelvin": {"type": "integer", "minimum": 2000, "maximum": 6500},
               "brightness": _BRIGHTNESS},
              ["light"]),
    ]


SYSTEM_RULES = """\
You are Ask, the natural-language control inside LightEmUp, a local app that runs \
the Philips Hue and Govee lights in one house. The person is talking to you from \
their phone, often by dictation, so expect missing punctuation and words misheard \
as similar ones. You act ONLY through the tools; never say you did something a \
tool didn't do.

How to read requests:
- Use room, zone, light, palette and preset names EXACTLY as listed below. Match \
loosely ("the hexa" = "Hex Lights", "outside" = the outdoor zone) but if it could \
mean more than one thing (several lamps), ask one short question instead of guessing.
- "Turn on the <room> lights" / "<room> on" with no color: set_white 2700K at 100%. \
Not set_power — that only resumes the last look.
- "<room> off": set_power off.
- "Dim": set_brightness to about 30% unless a number is given. "Brighter"/"full": 100%.
- A named color: set_color with a vivid RGB. A light cannot show brown, beige, gray \
or black — say so briefly and offer the nearest thing (warm white, orange).
- A mood or theme ("spooky", "cozy", "something autumnal"): apply_palette. Prefer a \
fitting palette by exact name ("spooky" -> Halloween); for "something <season or \
style>" use that category so a palette is picked at random.
- A team, college or country: apply_palette with preset = its exact name.
- "Release" / "include everything again": release_exclusions.

Exceptions and order (tools run in the order you call them):
- "<room> <look> but leave <light> alone" / "except <light>": exclude_lights FIRST, \
then the look.
- "<room> red but the <light> blue": the room-wide action first, then control_light \
for the exception.
- "Everything off except <room>": set_power with targets ["house"] and except_rooms.

Light shows:
- start_light_show defaults to mode "walk" and handles a room that is off (it puts up \
warm whites first). Use it to switch the mode of a running show too.
- Segmented Govee lights (marked "segmented" below) hold still during light shows, \
and that is deliberate. Animating their segments needs separate cloud calls about \
two seconds apart, so they flash a single color and fall out of step with the \
room. Never try to make them animate and never suggest it. If someone asks for it, \
say briefly that segmented lights hold still in light shows and that it can be \
changed in the Light Show panel.
- "Stop the light show" with no room: stop_light_show without a room.

House-wide actions (targets ["house"]) need a yes: the tool will refuse the first \
time and tell you to ask. Ask in one short sentence. Only if the user then agrees, \
call the same tool again with exactly the same arguments plus confirmed: true. \
Never set confirmed: true otherwise.

Questions ("what's the bedroom showing?", "is anything on upstairs?"): answer from \
the current state; don't call tools.

Things you can't do (schedules, settings, anything that isn't these lights): say so \
in a sentence.

Replies: one short, plain sentence saying what you did or asking your question. No \
markdown, no lists, no emojis."""


class _Convo:
    __slots__ = ("messages", "at", "pending")

    def __init__(self):
        self.messages: list = []
        self.at = time.time()
        self.pending: set = set()       # signatures of house-wide calls awaiting a yes


def _signature(name: str, args: dict) -> str:
    return name + json.dumps({k: v for k, v in sorted(args.items()) if k != "confirmed"},
                             sort_keys=True)


def _is_house_wide(name: str, args: dict) -> bool:
    return name in HOUSE_WIDE_TOOLS and any(
        str(t).strip().lower() == HOUSE for t in (args.get("targets") or []))


def _block_to_dict(b) -> Optional[dict]:
    t = getattr(b, "type", None)
    if t == "text":
        return {"type": "text", "text": b.text}
    if t == "tool_use":
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
    return None


class AskEngine:
    """One per app. `actions` maps tool name → async fn(**input) -> str summary
    (raise AskError for a request it can't carry out). `context` is an async fn
    returning {"layout": str, "state": str, "modes": [keys]}. `get_key` returns
    the API key or None. `usage_get` / `usage_put` read and store the usage tally
    (a dict) in config."""

    def __init__(self, actions: dict, context: Callable[[], Awaitable[dict]],
                 get_key: Callable[[], Optional[str]],
                 usage_get: Callable[[], dict], usage_put: Callable[[dict], None],
                 client_factory: Optional[Callable[[str], Any]] = None):
        self.actions = actions
        self.context = context
        self.get_key = get_key
        self.usage_get = usage_get
        self.usage_put = usage_put
        self._client_factory = client_factory
        self._client = None
        self._client_key = None
        self._convos: dict = {}

    # ── plumbing ────────────────────────────────────────────────────────────
    def _client_for(self, key: str):
        if self._client is None or self._client_key != key:
            if self._client_factory:
                self._client = self._client_factory(key)
            else:
                import anthropic   # imported here so the app runs without it installed
                self._client = anthropic.AsyncAnthropic(api_key=key, timeout=30.0, max_retries=2)
            self._client_key = key
        return self._client

    def _convo(self, client_id: str) -> _Convo:
        now = time.time()
        for cid in [c for c, v in self._convos.items() if now - v.at > CONVO_TTL_S]:
            self._convos.pop(cid, None)
        c = self._convos.get(client_id)
        if c is None:
            c = self._convos[client_id] = _Convo()
        return c

    def forget(self, client_id: str):
        self._convos.pop(client_id, None)

    def usage(self) -> dict:
        u = dict(self.usage_get() or {})
        today, month = time.strftime("%Y-%m-%d"), time.strftime("%Y-%m")
        if u.get("day") != today:
            u.update(day=today, count=0)
        if u.get("month") != month:
            u.update(month=month, month_count=0, month_cost=0.0)
        return u

    def _account(self, response) -> float:
        us = getattr(response, "usage", None)
        if us is None:
            return 0.0
        tok = lambda name: int(getattr(us, name, 0) or 0)
        return (tok("input_tokens") * PRICE["in"] + tok("output_tokens") * PRICE["out"]
                + tok("cache_creation_input_tokens") * PRICE["cache_write"]
                + tok("cache_read_input_tokens") * PRICE["cache_read"]) / 1_000_000

    # ── the request ─────────────────────────────────────────────────────────
    async def ask(self, client_id: str, text: str) -> dict:
        text = (text or "").strip()
        if not text:
            return {"reply": "Say or type what you'd like the lights to do.", "actions": []}
        key = self.get_key()
        if not key:
            return {"reply": "Ask needs an Anthropic API key — add one in Settings.",
                    "actions": [], "error": "no_key"}
        u = self.usage()
        if u.get("count", 0) >= DAILY_CAP:
            return {"reply": f"Ask has reached today's limit of {DAILY_CAP} requests.",
                    "actions": [], "error": "cap"}
        u["count"] = u.get("count", 0) + 1
        u["month_count"] = u.get("month_count", 0) + 1
        self.usage_put(u)

        try:
            client = self._client_for(key)
        except ImportError:
            return {"reply": "Ask isn't installed on the hub yet (the anthropic package "
                             "is missing) — redeploy to install it.", "actions": [], "error": "sdk"}

        ctx = await self.context()
        system = [{"type": "text", "text": SYSTEM_RULES + "\n\n" + ctx["layout"],
                   "cache_control": {"type": "ephemeral"}}]
        tools = build_tools(ctx.get("modes") or ["walk"])
        convo = self._convo(client_id)
        convo.at = time.time()
        # The live state rides with THIS turn only; earlier turns keep just the words,
        # so a stale "the study is off" can't contradict the current one.
        convo.messages.append({"role": "user", "content": text})
        request_messages = convo.messages[:-1] + [{"role": "user", "content": [
            {"type": "text", "text": "Current state of the house:\n" + ctx["state"]},
            {"type": "text", "text": text}]}]

        done, awaiting, cost, reply = [], False, 0.0, ""
        try:
            for _ in range(MAX_STEPS):
                response = await client.messages.create(
                    model=MODEL, max_tokens=MAX_TOKENS, system=system, tools=tools,
                    messages=request_messages)
                cost += self._account(response)
                blocks = [d for d in (_block_to_dict(b) for b in response.content) if d]
                request_messages.append({"role": "assistant", "content": blocks})
                convo.messages.append({"role": "assistant", "content": blocks})
                reply = " ".join(b["text"] for b in blocks if b["type"] == "text").strip()
                if response.stop_reason == "refusal":
                    reply = reply or "I can't help with that one."
                    break
                if response.stop_reason != "tool_use":
                    break
                results = []
                for b in blocks:
                    if b["type"] != "tool_use":
                        continue
                    content, is_error = await self._run(convo, b["name"], dict(b["input"] or {}))
                    if content.startswith("CONFIRMATION NEEDED"):
                        awaiting = True
                    elif not is_error:
                        done.append(content)
                    results.append({"type": "tool_result", "tool_use_id": b["id"],
                                    "content": content, **({"is_error": True} if is_error else {})})
                request_messages.append({"role": "user", "content": results})
                convo.messages.append({"role": "user", "content": results})
            else:
                reply = reply or "That took more steps than expected — some of it may be done."
                # Memory would end on a tool result; the next turn starts fresh instead.
                self.forget(client_id)
        except Exception as e:
            reply = self._explain(e)
            log.warning("Ask failed: %s", e)
            # A half-finished exchange would leave a dangling tool call in memory.
            self.forget(client_id)
        finally:
            u = self.usage()
            u["month_cost"] = round(float(u.get("month_cost", 0.0)) + cost, 6)
            self.usage_put(u)

        if len(convo.messages) > CONVO_MAX_MESSAGES:
            self.forget(client_id)
        if not reply:
            reply = "Done." if done else "I'm not sure what to do with that — could you rephrase it?"
        log.info("Ask %r -> %s | %s ($%.4f)", text, "; ".join(done) or "no action", reply, cost)
        return {"reply": reply, "actions": done, "awaiting": awaiting, "cost": round(cost, 5)}

    async def _run(self, convo: _Convo, name: str, args: dict) -> tuple:
        fn = self.actions.get(name)
        if fn is None:
            return f"Unknown action {name}.", True
        if _is_house_wide(name, args):
            sig = _signature(name, args)
            if not (args.get("confirmed") is True and sig in convo.pending):
                convo.pending.add(sig)
                return ("CONFIRMATION NEEDED — not done yet. This changes every room in the "
                        "house. Ask the user to confirm in one short sentence; if they say "
                        "yes, call this tool again with exactly the same arguments plus "
                        "confirmed: true."), False
            convo.pending.discard(sig)
        args.pop("confirmed", None)
        try:
            return str(await fn(**args)), False
        except AskError as e:
            return str(e), True
        except TypeError as e:
            return f"Those arguments don't fit {name}: {e}", True
        except Exception as e:
            log.exception("Ask action %s failed", name)
            return f"{name} failed on the hub: {e}", True

    @staticmethod
    def _explain(e: Exception) -> str:
        name = type(e).__name__
        if name == "AuthenticationError":
            return "The Anthropic API key was rejected — check it in Settings."
        if name == "PermissionDeniedError":
            return "That API key isn't allowed to use Claude — check it in the Anthropic console."
        if name == "RateLimitError":
            return "Claude is busy right now — try again in a moment."
        if name in ("APIConnectionError", "APITimeoutError"):
            return "Couldn't reach Claude — is the internet down? Everything else still works."
        if name == "BadRequestError" and "credit" in str(e).lower():
            return "The Anthropic account is out of credit."
        return "Something went wrong reaching Claude — try again."
