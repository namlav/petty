"""Build firmware.merged.bin after PlatformIO builds the ESP32 image."""

import subprocess
import sys
from pathlib import Path
from typing import Any


# PlatformIO injects `Import` and the requested `env` into extra scripts.
# Resolve the injected hook dynamically so ordinary Python language servers
# do not flag those SCons-provided names as undefined.
env: Any = None
_scons_import = globals().get("Import")
if _scons_import is None:
    raise RuntimeError("Run this script through PlatformIO as an extra script")
_scons_import("env")
if env is None:
    raise RuntimeError("PlatformIO did not provide the SCons build environment")


def _require(path: Path, label: str) -> Path:
    if not path.is_file():
        raise RuntimeError(f"Missing {label}: {path}. Run `pio run -d firmware` first.")
    return path


def merge_firmware(source, target, env):
    project_dir = Path(env.subst("$PROJECT_DIR"))
    build_dir = Path(env.subst("$BUILD_DIR"))

    platform = env.PioPlatform()
    try:
        esptool_package = platform.get_package_dir("tool-esptoolpy")
    except KeyError:
        esptool_package = None
    if not esptool_package:
        esptool_package = platform.get_package_dir("tool-esptool")
    if not esptool_package:
        raise RuntimeError("PlatformIO package tool-esptoolpy/tool-esptool is not installed")
    esptool_py = Path(esptool_package) / "esptool.py"
    esptool_exe = Path(esptool_package) / "esptool.exe"
    if esptool_py.is_file():
        esptool_command = [sys.executable, str(esptool_py)]
    elif esptool_exe.is_file():
        # Newer PlatformIO platforms ship esptool as a standalone executable.
        esptool_command = [str(esptool_exe)]
    else:
        raise RuntimeError(f"Neither esptool.py nor esptool.exe found in {esptool_package}")

    framework_package = platform.get_package_dir("framework-arduinoespressif32")
    if not framework_package:
        raise RuntimeError("PlatformIO package framework-arduinoespressif32 is not installed")

    bootloader = _require(build_dir / "bootloader.bin", "ESP32 bootloader")
    partitions = _require(build_dir / "partitions.bin", "partition table")
    app = _require(build_dir / "firmware.bin", "application firmware")
    boot_app0 = _require(
        Path(framework_package) / "tools" / "partitions" / "boot_app0.bin",
        "boot_app0.bin",
    )
    output = build_dir / "firmware.merged.bin"

    command = [
        *esptool_command,
        "--chip",
        "esp32",
        "merge_bin",
        "--flash_mode",
        "dio",
        "--flash_freq",
        "40m",
        "--flash_size",
        "4MB",
        "-o",
        str(output),
        "0x1000",
        str(bootloader),
        "0x8000",
        str(partitions),
        "0xe000",
        str(boot_app0),
        "0x10000",
        str(app),
    ]
    print("[merge_firmware] Creating", output)
    subprocess.run(command, cwd=project_dir, check=True)


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", merge_firmware)
