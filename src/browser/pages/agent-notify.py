#!/usr/bin/env python3
"""Install CLI completion hooks. Served with a publisher credential after authentication."""
import json
import os
import re
import shlex
import shutil
import sys
import tempfile
from pathlib import Path

TOKEN = None

HELPER = r'''import json
import platform
import subprocess
import sys
import urllib.request
from pathlib import Path

# Hooks must never fail or block the agent because a launcher is offline.
try:
    config = json.loads(Path(__file__).with_name("connection.json").read_text())
    tool = sys.argv[1]
    test = tool == "--test"
    payload = {} if test else json.loads(sys.argv[2] if tool == "codex" else sys.stdin.read())
    if not test and tool == "codex" and payload.get("type") != "agent-turn-complete":
        sys.exit(0)
    if not test and tool == "claude" and payload.get("hook_event_name") != "Stop":
        sys.exit(0)
    project = Path.cwd().name if test else Path(payload.get("cwd") or ".").name
    data = json.dumps({"tool": "codex" if test else tool,
                       "cwd": project,
                       "host": platform.node()}).encode()
    request = urllib.request.Request(config["endpoint"] + "/complete", data=data,
        headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            response.read()
        if test:
            print("Test notification sent.")
    finally:
        if tool == "codex" and config.get("previous_notify"):
            try:
                subprocess.run(config["previous_notify"] + [sys.argv[2]], timeout=5, check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass
except Exception as error:
    if "--test" in sys.argv:
        print("Notification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
'''


def write_private(file, text, backup=False):
    file.parent.mkdir(parents=True, exist_ok=True)
    if backup and file.exists():
        # Keep the first original copy; reinstalling must not replace it.
        original = file.with_name(file.name + ".before-agent-notifications")
        if not original.exists():
            fd = os.open(str(original), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as output, file.open("rb") as source:
                shutil.copyfileobj(source, output)
    fd, temp = tempfile.mkstemp(dir=str(file.parent))
    try:
        with os.fdopen(fd, "w") as output:
            output.write(text)
        os.replace(temp, file)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def codex_config(text, command, tomllib):
    parsed = tomllib.loads(text)
    expected = dict(parsed, notify=command)
    assignment = "notify = " + json.dumps(command, ensure_ascii=False) + "\n"
    if "notify" not in parsed:
        updated = assignment + text
    else:
        lines = text.splitlines(keepends=True)
        updated = None
        # Validate the whole result so comments, tables, and multiline values
        # cannot cause an unrelated setting to be rewritten.
        for start, line in enumerate(lines):
            if not re.match(r'''^\s*(?:notify|"notify"|'notify')\s*=''', line):
                continue
            for end in range(start + 1, len(lines) + 1):
                try:
                    value = tomllib.loads("".join(lines[start:end]))
                except tomllib.TOMLDecodeError:
                    continue
                if value != {"notify": parsed["notify"]}:
                    break
                candidate = "".join(lines[:start]) + assignment + "".join(lines[end:])
                if tomllib.loads(candidate) == expected:
                    updated = candidate
                break
            if updated is not None:
                break
        if updated is None:
            raise ValueError("Cannot safely update the existing Codex notify setting")
    if tomllib.loads(updated) != expected:
        raise ValueError("Codex configuration validation failed")
    return updated, parsed.get("notify", [])


def install():
    try:
        import tomllib
    except ImportError:
        raise SystemExit("Python 3.11 or newer is required. No settings were changed.")
    from urllib.parse import urlsplit

    if not TOKEN:
        raise SystemExit("Download the installer from the launcher's Notifications settings.")
    endpoint = sys.argv[1].rstrip("/") if len(sys.argv) == 2 else ""
    url = urlsplit(endpoint)
    if url.scheme not in ("http", "https") or not url.netloc or url.query or url.fragment or url.username:
        raise SystemExit("Pass the launcher notification URL as the only argument.")

    directory = Path.home() / ".local/share/code-server-remote/notifications"
    helper = directory / "notify.py"
    connection = directory / "connection.json"
    command = [sys.executable, str(helper), "codex"]
    codex = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "settings.json"
    updated, previous = codex_config(codex.read_text() if codex.exists() else "", command, tomllib)
    if isinstance(previous, list) and str(helper) in previous:
        previous = json.loads(connection.read_text()).get("previous_notify", []) if connection.exists() else []
    if not isinstance(previous, list) or any(not isinstance(arg, str) for arg in previous):
        raise ValueError("Existing Codex notify must be an array of strings")
    settings = json.loads(claude.read_text()) if claude.exists() else {}
    hook = {"type": "command", "command": shlex.join([sys.executable, str(helper), "claude"]), "timeout": 10}
    stops = settings.setdefault("hooks", {}).setdefault("Stop", [])
    if not any(h.get("command") == hook["command"] for group in stops for h in group.get("hooks", [])):
        stops.append({"hooks": [hook]})
    # Parse and validate both configurations before writing either one.
    claude_text = json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
    write_private(helper, HELPER)
    write_private(connection, json.dumps({"endpoint": endpoint, "token": TOKEN, "previous_notify": previous}))
    write_private(codex, updated, backup=True)
    write_private(claude, claude_text, backup=True)
    print("Completion notifications installed for Codex CLI and Claude Code. Restart both CLIs.")
    print("Keep the launcher tab open. Test with:")
    print(shlex.join([sys.executable, str(helper), "--test"]))


if __name__ == "__main__":
    install()
