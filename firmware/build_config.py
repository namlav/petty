"""Inject per-device TLS credentials for the PlatformIO production target."""

import json
import os
from pathlib import Path


_scons_import = globals().get("Import")
if _scons_import is None:
    raise RuntimeError("Run this script through PlatformIO as an extra script")
_scons_import("env")

pio_env = env.subst("$PIOENV")  # noqa: F821 - injected by PlatformIO/SCons
if pio_env == "production":
    required = ("PETTY_WS_HOST", "PETTY_DEVICE_TOKEN", "PETTY_ROOT_CA_FILE")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            "Production build requires environment variables: " + ", ".join(missing)
        )

    host = os.environ["PETTY_WS_HOST"].strip()
    token = os.environ["PETTY_DEVICE_TOKEN"]
    ca_path = Path(os.environ["PETTY_ROOT_CA_FILE"]).expanduser().resolve()
    if not host or any(char in host for char in "/\\?# "):
        raise RuntimeError("PETTY_WS_HOST must be a hostname without scheme, path, or port")
    if not token.strip():
        raise RuntimeError("PETTY_DEVICE_TOKEN cannot be empty")
    if not ca_path.is_file():
        raise RuntimeError("PETTY_ROOT_CA_FILE does not point to a CA certificate file")

    ca_pem = ca_path.read_text(encoding="ascii")
    if "-----BEGIN CERTIFICATE-----" not in ca_pem:
        raise RuntimeError("PETTY_ROOT_CA_FILE must contain a PEM certificate")

    env.Append(  # noqa: F821 - injected by PlatformIO/SCons
        CPPDEFINES=[
            ("WS_HOST", json.dumps(host)),
            ("DEVICE_TOKEN", json.dumps(token)),
            ("PETTY_ROOT_CA", json.dumps(ca_pem)),
        ]
    )
