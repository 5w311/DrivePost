#!/usr/bin/env python3
"""
Looks inside the signed "Send to Car" Shortcut and checks that it holds
exactly the Shortcut in shortcut/send-to-car.unsigned.plist.

    python3 scripts/inspect-shortcut.py

A signed Shortcut is an Apple archive: a short header with the signer's
certificates, then the Shortcut itself, compressed. This script unpacks it
without any Apple software, so anyone can confirm what the file in
server/public/send-to-car.shortcut will add to a phone. It needs only Python 3;
with the "cryptography" package installed it also shows who signed the file.
"""
import os
import plistlib
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNED = os.path.join(ROOT, "server", "public", "send-to-car.shortcut")
UNSIGNED = os.path.join(ROOT, "shortcut", "send-to-car.unsigned.plist")
# Apple's signing tool stamps its own version on the file; everything else must match.
STAMPED = {"WFWorkflowClientVersion"}


def lzvn_decode(src, size):
    """Apple's LZVN compression (the 'bvxn' block of an LZFSE stream)."""
    out = bytearray()
    i = 0
    dist = 0

    def literal(n):
        nonlocal i
        out.extend(src[i:i + n])
        i += n

    def match(n):
        if dist == 0 or dist > len(out):
            raise ValueError("damaged data")
        for _ in range(n):
            out.append(out[-dist])

    while i < len(src):
        op = src[i]
        low = op & 7
        if op >= 240:  # repeat earlier bytes
            n = src[i + 1] + 16 if op == 240 else op & 15
            i += 2 if op == 240 else 1
            match(n)
        elif op >= 224:  # plain bytes
            n = src[i + 1] + 16 if op == 224 else op & 15
            i += 2 if op == 224 else 1
            literal(n)
        elif 208 <= op <= 223 or 112 <= op <= 127:
            raise ValueError("damaged data")
        elif 160 <= op <= 191:  # plain bytes, then repeat from a medium distance
            two = src[i + 1] | (src[i + 2] << 8)
            n_lit, n_match = (op >> 3) & 3, (((op & 7) << 2) | (two & 3)) + 3
            dist = two >> 2
            i += 3
            literal(n_lit)
            match(n_match)
        elif low == 6 and op == 6:  # end
            break
        elif low == 6 and op in (14, 22):  # filler
            i += 1
        elif low == 6 and op < 64:
            raise ValueError("damaged data")
        else:
            n_lit, n_match = op >> 6, ((op >> 3) & 7) + 3
            if low == 6:  # same distance as last time
                i += 1
            elif low == 7:  # far
                dist = src[i + 1] | (src[i + 2] << 8)
                i += 3
            else:  # near
                dist = ((op & 7) << 8) | src[i + 1]
                i += 2
            literal(n_lit)
            match(n_match)
    if len(out) != size:
        raise ValueError("damaged data")
    return bytes(out)


def unpack(signed):
    """Returns (certificates, {file name: contents}) from a signed Shortcut."""
    if signed[:4] != b"AEA1":
        raise ValueError("not a signed Shortcut")
    n = struct.unpack("<I", signed[8:12])[0]
    certs = plistlib.loads(signed[12:12 + n]).get("SigningCertificateChain", [])
    rest = signed[12 + n:]
    at = rest.find(b"bvxn")
    if at < 0:
        raise ValueError("no compressed data found")
    size, packed = struct.unpack("<II", rest[at + 4:at + 12])
    archive = lzvn_decode(rest[at + 12:at + 12 + packed], size)

    files = {}
    o = 0
    while o < len(archive):
        if archive[o:o + 4] != b"AA01":
            raise ValueError("unexpected archive contents")
        header_size = struct.unpack("<H", archive[o + 4:o + 6])[0]
        header = archive[o + 6:o + header_size]
        name, data_size, k = "", 0, 0
        while k < len(header):
            key = header[k:k + 4].decode("latin1")
            k += 4
            kind = key[3]
            if key[:3] == "DAT":
                width = {"A": 2, "B": 4, "C": 8}[kind]
                data_size = int.from_bytes(header[k:k + width], "little")
                k += width
            elif kind == "P":
                length = struct.unpack("<H", header[k:k + 2])[0]
                if key == "PATP":
                    name = header[k + 2:k + 2 + length].decode()
                k += 2 + length
            elif kind in "1248":
                k += int(kind)
            elif kind in "ST":
                k += 8 if kind == "S" else 12
            else:
                raise ValueError("unexpected archive field " + key)
        if data_size:
            files[name] = archive[o + header_size:o + header_size + data_size]
        o += header_size + data_size
    return certs, files


def main():
    signed_path = sys.argv[1] if len(sys.argv) > 1 else SIGNED
    certs, files = unpack(open(signed_path, "rb").read())

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes
        print("Signed by:")
        for der in certs:
            cert = x509.load_der_x509_certificate(der)
            names = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
            print("  %s (until %s)" % (names[0].value if names else "?", cert.not_valid_after_utc.date()))
        root = x509.load_der_x509_certificate(certs[-1]).fingerprint(hashes.SHA256()).hex()
        print("  root certificate fingerprint: " + root)
    except ImportError:
        print("Signed with %d certificates (install the 'cryptography' package to see them)." % len(certs))

    if list(files) != ["Shortcut.wflow"]:
        print("Unexpected files inside: %s" % sorted(files))
        return 1
    inside = plistlib.loads(files["Shortcut.wflow"])
    source = plistlib.load(open(UNSIGNED, "rb"))
    differing = sorted(k for k in set(inside) | set(source) if inside.get(k) != source.get(k))
    for action in inside["WFWorkflowActions"]:
        print("Action: " + action["WFWorkflowActionIdentifier"])
    if set(differing) <= STAMPED:
        print("OK: the signed file holds exactly the Shortcut in shortcut/send-to-car.unsigned.plist.")
        return 0
    print("DIFFERENT from shortcut/send-to-car.unsigned.plist in: " + ", ".join(differing))
    return 1


if __name__ == "__main__":
    sys.exit(main())
