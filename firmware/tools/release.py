#!/usr/bin/env python3
"""Sign and publish firmware, so frames update themselves over Wi-Fi.

  python3 tools/release.py keygen    Once: make the signing key (kept outside the repo, in
                                     ~/.domiframe/, or DOMIFRAME_FW_KEY) and write its public
                                     half into include/fw_key.h. Back the key up: without it
                                     frames can only be updated over USB.
  python3 tools/release.py publish   Build every frame type at FW_VERSION (include/config.h),
                                     sign the images, and put them in web/firmware/, listed in
                                     netlify/lib/firmware-releases.mjs for the server.

Then commit and push: once the site deploys, frames update at their next check-in. Raise
FW_VERSION before each release; frames only ever move to a newer version.

What's signed (ECDSA P-256 over SHA-256) is "domiframe-fw|<build>|<version>|<image sha256>",
which the frame checks in signatureOk (src/main.cpp).
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

FIRMWARE = Path(__file__).resolve().parents[1]
REPO = FIRMWARE.parent
KEY = Path(os.environ.get("DOMIFRAME_FW_KEY", "~/.domiframe/firmware-signing-key.pem")).expanduser()
KEY_HEADER = FIRMWARE / "include" / "fw_key.h"
OUT = REPO / "web" / "firmware"
RELEASES = REPO / "netlify" / "lib" / "firmware-releases.mjs"
ENVS = ["ee04", "ee02-13in3"]  # platformio.ini, and FW_ENV in include/config.h


def run(*cmd, data=None):
    return subprocess.run(cmd, input=data, capture_output=True, check=True).stdout


def public_pem():
    return run("openssl", "ec", "-in", str(KEY), "-pubout").decode().strip()


def header_pem():
    """The public key include/fw_key.h holds ("" if none)."""
    lines = re.findall(r'"([^"]*)\\n"', KEY_HEADER.read_text().split("FW_SIGNING_KEY")[1])
    return "\n".join(lines)


def verify(pem, message, sig):
    """Check a signature the way the frame will, with the public key it has."""
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "key.pem").write_text(pem + "\n")
        (Path(tmp) / "sig.der").write_bytes(sig)
        run("openssl", "dgst", "-sha256", "-verify", f"{tmp}/key.pem", "-signature", f"{tmp}/sig.der", data=message)


def write_header(pem):
    literal = "".join(f'\n    "{line}\\n"' for line in pem.splitlines())
    KEY_HEADER.write_text(KEY_HEADER.read_text().split("static const char")[0]
                          + f"static const char FW_SIGNING_KEY[] ={literal};\n")


def keygen():
    if KEY.exists():
        print(f"Using the key already at {KEY}")
    else:
        KEY.parent.mkdir(parents=True, exist_ok=True)
        run("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(KEY))
        KEY.chmod(0o600)
        print(f"Made a signing key at {KEY}. Back it up somewhere safe, and never commit it.")
    write_header(public_pem())
    print(f"Wrote its public key to {KEY_HEADER.relative_to(REPO)}. Flash frames once over USB to "
          "give them this key; after that they update over Wi-Fi.")


def load_releases():
    text = RELEASES.read_text()
    return json.loads(text[text.index("export default") + len("export default"):].strip().rstrip(";"))


def version_tuple(v):
    return tuple(int(x) for x in v.split("."))


def pio():
    found = shutil.which("pio") or str(Path("~/.platformio/penv/bin/pio").expanduser())
    if not Path(found).exists():
        sys.exit("PlatformIO isn't installed (https://platformio.org/install/cli)")
    return found


def publish():
    if not KEY.exists():
        sys.exit(f"No signing key at {KEY}. Run `python3 tools/release.py keygen` first.")
    if header_pem() != public_pem():
        sys.exit("include/fw_key.h doesn't hold this key's public half: run keygen to write it.")
    version = re.search(r'#define FW_VERSION "([\d.]+)"', (FIRMWARE / "include" / "config.h").read_text()).group(1)
    releases = load_releases()
    for env in ENVS:
        if env in releases and version_tuple(version) <= version_tuple(releases[env]["version"]):
            sys.exit(f"{env} {releases[env]['version']} is already out: raise FW_VERSION in include/config.h")

    OUT.mkdir(exist_ok=True)
    for env in ENVS:
        print(f"Building {env} {version}...")
        subprocess.run([pio(), "run", "-e", env], cwd=FIRMWARE, check=True)
        image = (FIRMWARE / ".pio" / "build" / env / "firmware.bin").read_bytes()
        message = f"domiframe-fw|{env}|{version}|{hashlib.sha256(image).hexdigest()}".encode()
        sig = run("openssl", "dgst", "-sha256", "-sign", str(KEY), data=message)
        verify(header_pem(), message, sig)
        name = f"{env}-{version}.bin"
        for old in OUT.glob(f"{env}-*.bin"):
            old.unlink()
        (OUT / name).write_bytes(image)
        releases[env] = {"version": version, "file": name, "size": len(image), "sig": base64.b64encode(sig).decode()}
        print(f"  web/firmware/{name}: {len(image):,} bytes, signed")

    RELEASES.write_text(RELEASES.read_text().split("export default")[0]
                        + "export default " + json.dumps(releases, indent=2) + ";\n")
    print(f"Listed in {RELEASES.relative_to(REPO)}. Commit and push to send {version} to the frames.")


if __name__ == "__main__":
    commands = {"keygen": keygen, "publish": publish}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        sys.exit(__doc__)
    commands[sys.argv[1]]()
