#!/usr/bin/env python3
"""Build firmware/data/cert/x509_crt_bundle.bin: the root certificates the frame trusts.

    pip install cryptography
    python3 firmware/tools/make_ca_bundle.py                        # Mozilla's list + extra_roots.pem
    python3 firmware/tools/make_ca_bundle.py --check domiframe.com  # would the frame trust this server?

Rerun every year or so and reflash, to pick up new root CAs, and run --check after changing
hosting or DNS. The format is ESP-IDF's certificate bundle (what WiFiClientSecure::setCACertBundle
reads): a big-endian uint16 count, then per certificate uint16 name length, uint16 key length,
DER subject, DER public key, sorted by subject so the frame can binary-search it.
"""
import argparse
import re
import struct
import subprocess
import urllib.request
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

MOZILLA = "https://curl.se/ca/cacert.pem"  # Mozilla's CA list, converted to PEM by the curl project
HERE = Path(__file__).resolve().parent
EXTRA = HERE / "extra_roots.pem"
OUT = HERE.parent / "data" / "cert" / "x509_crt_bundle.bin"


def build(pem):
    extra = EXTRA.read_bytes() if EXTRA.exists() else b""
    certs = x509.load_pem_x509_certificates(pem) + (x509.load_pem_x509_certificates(extra) if b"BEGIN" in extra else [])
    entries = sorted({
        (c.subject.public_bytes(),
         c.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
        for c in certs
    })
    out = struct.pack(">H", len(entries))
    for name, key in entries:
        out += struct.pack(">HH", len(name), len(key)) + name + key
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(out)
    print(f"{len(entries)} root certificates, {len(out)} bytes -> {OUT.relative_to(HERE.parent.parent)}")


def read_bundle():
    data = OUT.read_bytes()
    (n,), pos, roots = struct.unpack_from(">H", data), 2, {}
    for _ in range(n):
        name_len, key_len = struct.unpack_from(">HH", data, pos)
        pos += 4
        roots[data[pos:pos + name_len]] = data[pos + name_len:pos + name_len + key_len]
        pos += name_len + key_len
    return roots


def check(host):
    """Do what the frame's TLS check does: find the issuer of the last certificate the server
    sends in the bundle, and verify that certificate's signature with it."""
    try:
        shown = subprocess.run(["openssl", "s_client", "-connect", f"{host}:443", "-servername", host, "-showcerts"],
                               input=b"", capture_output=True, timeout=20).stdout.decode()
    except subprocess.TimeoutExpired:
        shown = ""
    chain = [x509.load_pem_x509_certificate(m.encode())
             for m in re.findall(r"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----", shown, re.S)]
    if not chain:
        # Not a failure: the site may not be live yet. A reachable but untrusted server is.
        print(f"warning: couldn't reach {host} over HTTPS, nothing to check")
        return
    top = chain[-1]
    print(f"{host}: {len(chain)} certificates, the last is {top.subject.rfc4514_string()}")
    key_der = read_bundle().get(top.issuer.public_bytes())
    if not key_der:
        raise SystemExit(f"NOT TRUSTED: its issuer {top.issuer.rfc4514_string()} isn't in the bundle. "
                         "Add that root to extra_roots.pem and rerun.")
    key = serialization.load_der_public_key(key_der)
    if isinstance(key, rsa.RSAPublicKey):
        key.verify(top.signature, top.tbs_certificate_bytes, padding.PKCS1v15(), top.signature_hash_algorithm)
    elif isinstance(key, ec.EllipticCurvePublicKey):
        key.verify(top.signature, top.tbs_certificate_bytes, ec.ECDSA(top.signature_hash_algorithm))
    else:
        raise SystemExit(f"unexpected key type {type(key).__name__}")
    print(f"trusted: signed by {top.issuer.rfc4514_string()}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pem", nargs="?", help="root certificates (PEM) instead of downloading Mozilla's")
    ap.add_argument("--check", metavar="HOST", help="only check a server against the existing bundle")
    args = ap.parse_args()
    if args.check:
        return check(args.check)
    if args.pem:
        pem = Path(args.pem).read_bytes()
    else:
        with urllib.request.urlopen(MOZILLA) as r:
            pem = r.read()
    build(pem)


if __name__ == "__main__":
    main()
