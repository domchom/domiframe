#pragma once
// The public key that firmware updates must be signed with (ECDSA P-256). Written by
// `python3 tools/release.py keygen`, which keeps the private key outside the repo. While it's
// empty, the frame never installs updates over Wi-Fi.
static const char FW_SIGNING_KEY[] =
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVILxQWu/l9QG3Snj5ueNByhKRSeS\n"
    "xC2fyoTlfcpR4Ug6sS4XZvk7Xyg5MBtjFrpCXxTLaA3xhLru6vxStVcmDA==\n"
    "-----END PUBLIC KEY-----\n";
