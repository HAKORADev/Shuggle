#!/usr/bin/env python3
"""Shuggle — Windows resources for the cross-compiled executable.

Bun can only embed an .ico when it compiles ON Windows, so the Windows binary
built from Linux gets its icon (and version info) injected here.

The PE keeps the CONSOLE subsystem on purpose: the CLI verbs (cli / chat /
tokens / status) must print to the terminal, and the window mode hides the
console at runtime instead.

  python3 scripts/windows_resources.py <exe> [icon.ico]
"""

import os
import struct
import sys

import pefile

RT_ICON = 3
RT_GROUP_ICON = 14
RT_VERSION = 16
LANG = 0x0409


# --------------------------------------------------------------------------- ico
def read_ico(path):
    """Return [(width, height, png_bytes)] for every image in the .ico."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"\x00\x00\x01\x00":
        raise SystemExit(f"{path} is not an .ico file")
    count = struct.unpack_from("<H", data, 4)[0]
    out = []
    for i in range(count):
        off = 6 + i * 16
        w, h, _, _, planes, bpp, size, data_off = struct.unpack_from("<BBBBHHII", data, off)
        blob = data[data_off:data_off + size]
        # Windows wants PNG-compressed images for the big sizes; keep the
        # original bytes (the .ico already stores PNGs where it matters).
        out.append((w or 256, h or 256, blob, planes, bpp))
    return out


# ------------------------------------------------------------------- resources

# --------------------------------------------------------------- version info
def _utf16(text):
    return text.encode("utf-16-le") + b"\x00\x00"


def _pad(buf, mult=4):
    return buf + b"\x00" * ((-len(buf)) % mult)


def _make_string(key, value):
    body = _pad(_utf16(key))
    v = _utf16(value)
    body += v
    length = 6 + len(body)
    length += (-length) % 4
    return struct.pack("<HHH", length, len(v) // 2, 1) + body


def _make_string_table(strings, lang="040904b0"):
    body = _pad(_utf16(lang))
    for key, value in strings:
        body += _make_string(key, value)
    length = 6 + len(body)
    length += (-length) % 4
    return struct.pack("<HHH", length, 0, 1) + body


def _make_string_file_info(strings):
    body = _pad(_utf16("StringFileInfo")) + _make_string_table(strings)
    length = 6 + len(body)
    length += (-length) % 4
    return struct.pack("<HHH", length, 0, 1) + body


def _make_var_file_info():
    var_body = _pad(_utf16("Translation")) + struct.pack("<HH", 0x0409, 0x04B0)
    var_length = 6 + len(var_body)
    var_length += (-var_length) % 4
    var = struct.pack("<HHH", var_length, 4, 0) + var_body
    body = _pad(_utf16("VarFileInfo")) + var
    length = 6 + len(body)
    length += (-length) % 4
    return struct.pack("<HHH", length, 0, 1) + body


def build_version_info(strings, major=0, minor=5, micro=0, revision=0):
    """A real VS_VERSIONINFO — what Explorer shows in the file properties."""
    fixed = struct.pack(
        "<IIIIIIIIIIIII",
        0xFEEF04BD,          # signature
        0x00010000,          # struct version
        (major << 16) | minor,
        (micro << 16) | revision,
        (major << 16) | minor,
        (micro << 16) | revision,
        0x3F,                # file flags mask
        0x00,                # file flags
        0x00040004,          # VOS_NT_WINDOWS32
        0x00000001,          # VFT_APP
        0x00000000,          # file subtype
        0x00000000, 0x00000000,
    )
    body = _pad(_utf16("VS_VERSION_INFO")) + fixed
    body = _pad(body)
    body += _make_string_file_info(strings) + _make_var_file_info()
    length = 6 + len(body)
    length += (-length) % 4
    return struct.pack("<HHH", length, len(fixed), 0) + body


def build_resource_section(icons, version_blob, section_rva):
    """Build a fresh .rsrc image: RT_ICON entries, one RT_GROUP_ICON and the
    version info. Everything lands in the section, so the PE headers do not
    change — the old section is simply overwritten."""
    payloads = []  # (type, id, lang, bytes)
    for i, (w, h, blob, planes, bpp) in enumerate(icons):
        payloads.append((RT_ICON, i + 1, LANG, blob))

    group = struct.pack("<HHH", 0, 1, len(icons))
    for i, (w, h, blob, planes, bpp) in enumerate(icons):
        group += struct.pack(
            "<BBBBHHIH",
            w if w < 256 else 0,   # width  (0 = 256)
            h if h < 256 else 0,   # height (0 = 256)
            0,                     # palette size
            0,                     # reserved
            planes or 1,           # colour planes
            bpp or 32,             # bits per pixel
            len(blob),             # bytes in this image
            i + 1,                 # the icon id
        )
    payloads.append((RT_GROUP_ICON, 1, LANG, group))
    if version_blob:
        payloads.append((RT_VERSION, 1, LANG, version_blob))

    types = sorted({p[0] for p in payloads})
    ids = {t: sorted({p[1] for p in payloads if p[0] == t}) for t in types}
    langs = {}
    for t, i, l, _ in payloads:
        langs.setdefault((t, i), set()).add(l)

    # ---- lay the tree out
    # level 1 = types, level 2 = the ids under that type, level 3 = languages
    l2, l3 = {}, {}
    cursor = 16 + 8 * len(types)  # the root directory lists every type
    for t in types:
        l2[t] = cursor
        cursor += 16 + 8 * len(ids[t])
        for i in ids[t]:
            ls = sorted(langs[(t, i)])
            for l in ls:
                l3[(t, i, l)] = cursor
                cursor += 16 + 8
    data_entry = {}
    for p in payloads:
        data_entry[p[:3]] = cursor
        cursor += 16
    blob_at = {}
    for p in payloads:
        blob_at[p[:3]] = cursor
        cursor += len(p[3])

    buf = bytearray(cursor)

    def header(count):
        return struct.pack("<IIHHHH", 0, 0, 0, 0, 0, count)

    def subdir(off):
        return 0x80000000 | off

    # level 1: the root, one entry per type
    buf[0:16] = header(len(types))
    for idx, t in enumerate(types):
        buf[16 + 8 * idx: 24 + 8 * idx] = struct.pack("<II", t, subdir(l2[t]))
    for t in types:
        # level 2: the ids under this type
        base = l2[t]
        buf[base: base + 16] = header(len(ids[t]))
        for idx, i in enumerate(ids[t]):
            pos = base + 16 + 8 * idx
            lang0 = sorted(langs[(t, i)])[0]
            buf[pos: pos + 8] = struct.pack("<II", i, subdir(l3[(t, i, lang0)]))
    for key, blob in ((p[:3], p[3]) for p in payloads):
        t, i, l = key
        base = l3[(t, i, l)]
        buf[base: base + 16] = header(1)
        buf[base + 16: base + 24] = struct.pack("<II", l, data_entry[key])
        dpos = data_entry[key]
        buf[dpos: dpos + 16] = struct.pack(
            "<IIII", section_rva + blob_at[key], len(blob), 0, 0
        )
        bpos = blob_at[key]
        buf[bpos: bpos + len(blob)] = blob

    return bytes(buf)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python3 scripts/windows_resources.py <exe> [icon.ico]")
    exe_path = sys.argv[1]
    icon_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "shuggle.ico"
    )

    icons = read_ico(icon_path)
    pe = pefile.PE(exe_path, fast_load=True)

    # the resource section
    rsrc = None
    for sec in pe.sections:
        if sec.Name.rstrip(b"\x00") == b".rsrc":
            rsrc = sec
            break
    if rsrc is None:
        raise SystemExit("no .rsrc section in this executable")
    section_rva = rsrc.VirtualAddress
    section_raw = rsrc.PointerToRawData
    section_size = rsrc.SizeOfRawData

    # our own version info — Bun's says "bun.exe / Oven"
    version_blob = build_version_info(
        [
            ("CompanyName", "HAKORA"),
            ("ProductName", "Shuggle"),
            ("FileDescription", "Free chats on free GPUs"),
            ("FileVersion", "0.5.0"),
            ("ProductVersion", "0.5.0"),
            ("InternalName", "Shuggle"),
            ("OriginalFilename", "Shuggle.exe"),
            ("LegalCopyright", "MIT licensed - HAKORA"),
        ],
        0,
        5,
        0,
        0,
    )

    blob = build_resource_section(icons, version_blob, section_rva)
    if len(blob) > section_size:
        raise SystemExit(
            f"the new resources ({len(blob)} bytes) do not fit in the section ({section_size} bytes)"
        )

    with open(exe_path, "r+b") as fh:
        fh.seek(section_raw)
        fh.write(blob)
        # zero the rest of the section so no stale data lingers
        fh.write(b"\x00" * (section_size - len(blob)))

    print(
        f"  icon injected into {os.path.basename(exe_path)}: "
        f"{len(icons)} sizes, {len(blob)} bytes of resources"
    )


if __name__ == "__main__":
    main()
