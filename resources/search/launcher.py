#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""FreeLM's local-only, offline-installed SearXNG helper.

The caller owns the process lifecycle. This launcher never installs packages or
downloads software, and the signed resource directory remains read-only.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
import tempfile
import threading
import time


def parse_arguments():
    parser = argparse.ArgumentParser(description="FreeLM bundled search helper")
    parser.add_argument("--config-dir", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--engines-json", required=True)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    try:
        selected = json.loads(args.engines_json)
    except (ValueError, TypeError):
        parser.error("engines-json must contain a JSON array")
    if not isinstance(selected, list) or not selected or len(selected) > 32:
        parser.error("select between 1 and 32 search engines")
    if any(not isinstance(item, str) or len(item) > 100 for item in selected):
        parser.error("engine names must be short strings")
    if len(set(selected)) != len(selected):
        parser.error("engine names must be unique")
    catalog = json.loads((Path(__file__).parent / "engines.json").read_text())
    available = {item["name"] for item in catalog["engines"]}
    if not set(selected).issubset(available):
        parser.error("an engine is not included in this FreeLM search bundle")
    return args, selected


def atomic_write(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".search-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def configure(args, selected):
    config_dir = Path(args.config_dir).resolve()
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_dir = config_dir / "cache"
    cache_dir.mkdir(exist_ok=True, mode=0o700)
    tmp_dir = cache_dir / "tmp"
    tmp_dir.mkdir(exist_ok=True, mode=0o700)
    secret_path = config_dir / "secret.key"
    if secret_path.exists():
        secret = secret_path.read_text(encoding="utf-8").strip()
        if len(secret) < 32:
            raise ValueError("bundled search secret.key is invalid")
    else:
        secret = secrets.token_hex(32)
        atomic_write(secret_path, secret + "\n")
    settings = {
        "use_default_settings": {"engines": {"keep_only": selected}},
        "general": {"debug": False, "instance_name": "FreeLM Search", "enable_metrics": False},
        "search": {"formats": ["html", "json"], "safe_search": 0, "autocomplete": "", "favicon_resolver": ""},
        "server": {
            "bind_address": "127.0.0.1", "port": args.port,
            "base_url": "http://127.0.0.1:" + str(args.port) + "/",
            "secret_key": secret, "limiter": False, "public_instance": False,
            "image_proxy": False, "method": "GET",
        },
        "valkey": {"url": False},
        "outgoing": {"request_timeout": 8.0, "max_request_timeout": 12.0, "pool_connections": 32},
        "engines": [{"name": name, "disabled": False} for name in selected],
    }
    # JSON is a YAML subset. Avoid interpolating user data into YAML syntax.
    atomic_write(config_dir / "settings.yml", json.dumps(settings, indent=2) + "\n")
    # SearXNG reads this defaults file during initialization even with its limiter
    # disabled. Store the complete defaults beside the generated local settings.
    limiter_path = config_dir / "limiter.toml"
    if not limiter_path.exists():
        shutil.copyfile(Path(__file__).parent / "source/searx/limiter.toml", limiter_path)
        os.chmod(limiter_path, 0o600)
    for key in list(os.environ):
        if key.startswith("SEARXNG_"):
            del os.environ[key]
    os.environ.update({
        "SEARXNG_SETTINGS_PATH": str(config_dir / "settings.yml"),
        "SEARXNG_DISABLE_ETC_SETTINGS": "1",
        "HOME": str(config_dir), "XDG_CACHE_HOME": str(cache_dir),
        "XDG_CONFIG_HOME": str(config_dir), "TMPDIR": str(tmp_dir),
    })
    tempfile.tempdir = str(tmp_dir)
    os.chdir(config_dir)


def watch_parent(parent_pid):
    if not parent_pid:
        return
    try:
        expected = int(parent_pid)
    except ValueError:
        raise ValueError("invalid FreeLM parent process") from None
    if expected <= 1:
        raise ValueError("invalid FreeLM parent process")

    def watch():
        while True:
            time.sleep(2)
            if os.getppid() != expected:
                # FreeLM crashed or disappeared. Never leave a background server.
                os._exit(0)
    threading.Thread(target=watch, name="freelm-parent-watch", daemon=True).start()


def main():
    args, selected = parse_arguments()
    instance_id = os.environ.get("FREELM_SEARCH_INSTANCE_ID", "")
    if instance_id and (len(instance_id) > 128 or not all(c in "0123456789abcdef" for c in instance_id)):
        raise ValueError("invalid FreeLM search instance identifier")
    parent_pid = os.environ.get("FREELM_SEARCH_PARENT_PID")
    configure(args, selected)
    root = Path(__file__).resolve().parent
    runtime = Path(sys.executable).resolve().parents[2]
    sys.path.insert(0, str(runtime / "site-packages"))
    sys.path.insert(0, str(root / "source"))
    watch_parent(parent_pid)
    from searx.webapp import app
    from waitress import create_server

    @app.after_request
    def mark_instance(response):
        if instance_id:
            response.headers["X-FreeLM-Search-Instance"] = instance_id
        return response

    def local_peer_application(environ, start_response):
        # This WSGI server is the only proxy and binds to loopback. Give SearXNG
        # the actual socket peer after Waitress discards untrusted HTTP headers;
        # direct desktop requests do not need to invent proxy headers themselves.
        environ["HTTP_X_REAL_IP"] = environ.get("REMOTE_ADDR", "127.0.0.1")
        return app(environ, start_response)

    # No debug reloader, external bind, TLS proxy, or additional service process.
    server = create_server(
        local_peer_application, host="127.0.0.1", port=args.port, threads=4,
        connection_limit=32, channel_timeout=30,
        max_request_header_size=16384, max_request_body_size=32768,
        clear_untrusted_proxy_headers=True,
    )
    print("FreeLM Search listening on http://127.0.0.1:" + str(args.port), flush=True)
    try:
        server.run()
    finally:
        server.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FreeLM Search failed: " + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
