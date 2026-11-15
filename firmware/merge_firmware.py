# Build an ESP32 full-flash image for Wokwi, including PlatformIO's bootloader,
# custom partition table, and application image.
Import("env")

from os.path import join
import sys


def merge_firmware(source, target, env):
    board = env.BoardConfig()
    build_dir = env.subst("$BUILD_DIR")
    merged = join(build_dir, "firmware.merged.bin")
    # PlatformIO's ESP32 platform ships esptool as a Python package.
    platform = env.PioPlatform()
    esptool_dir = platform.get_package_dir("tool-esptoolpy") or platform.get_package_dir(
        "tool-esptool"
    )
    esptool_py = join(esptool_dir, "esptool.py")

    images = [
        (offset, env.subst(path))
        for offset, path in env.get("FLASH_EXTRA_IMAGES", [])
    ]
    images.append((env.subst("$ESP32_APP_OFFSET"), str(target[0])))

    command = [
        '"{}"'.format(sys.executable),
        '"{}"'.format(esptool_py),
        "--chip",
        board.get("build.mcu", "esp32"),
        "merge_bin",
        "-o",
        '"{}"'.format(merged),
        "--flash_mode",
        board.get("build.flash_mode", "dio"),
        "--flash_size",
        board.get("upload.flash_size", "4MB"),
    ]
    for offset, path in images:
        command.extend(
            [offset if isinstance(offset, str) else hex(offset), '"{}"'.format(path)]
        )

    env.Execute(env.VerboseAction(" ".join(command), "Merging full Wokwi flash image"))


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", merge_firmware)
