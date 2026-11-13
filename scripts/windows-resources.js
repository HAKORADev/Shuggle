// Shuggle — Windows resources for the cross-compiled executable.
//
// Bun can only embed an .ico when it compiles ON Windows, so the Windows
// binary built from Linux gets its icon and version info injected here with
// resedit (a pure-JS PE resource editor). The subsystem stays CONSOLE — the
// CLI verbs (cli / chat / tokens / status) must print to the terminal, and
// the window mode hides the console at runtime instead.
//
//   node scripts/windows-resources.js <exe> <icon.ico>

const fs = require("node:fs");
const path = require("node:path");
const { NtExecutable, NtExecutableResource, Data, Resource, Version } = require("resedit");

const exePath = process.argv[2];
const iconPath = process.argv[3] || path.join(__dirname, "..", "assets", "shuggle.ico");
if (!exePath) {
  console.error("usage: node scripts/windows-resources.js <exe> [icon.ico]");
  process.exit(2);
}

const exe = NtExecutable.from(fs.readFileSync(exePath));
const res = exe.resources;

// ---- icon ------------------------------------------------------------------
const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 32512;
Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  groupId,
  1033,
  iconFile.icons.map((item) => item.data),
);

// ---- version info ----------------------------------------------------------
const existing = Resource.VersionInfo.fromEntries(res.entries);
const vi = existing.length ? existing[0] : Resource.VersionInfo.createEmpty();
vi.setFileVersion(0, 5, 0, 0, 1033);
vi.setProductVersion(0, 5, 0, 0, 1033);
vi.setStringValues(
  { lang: 1033 },
  {
    CompanyName: "HAKORA",
    ProductName: "Shuggle",
    FileDescription: "Free chats on free GPUs",
    FileVersion: "0.5.0",
    ProductVersion: "0.5.0",
    InternalName: "Shuggle",
    OriginalFilename: "Shuggle.exe",
    LegalCopyright: "MIT licensed — HAKORA",
  },
  true,
);
if (!existing.length) res.entries.push(vi.generateEntry());

// ---- write -----------------------------------------------------------------
exe.write(exePath);
console.log(`  icon + version info injected into ${path.basename(exePath)} (${iconFile.icons.length} icon sizes)`);
