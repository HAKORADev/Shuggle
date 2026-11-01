// Shuggle — account command: create this device's account from the terminal.
//
// The window has a first-run wizard; the terminal needs its own path, or the
// CLI is unusable on a fresh machine (one account per device — the device
// keeps a signature so a second account can't be created from here).

import { connectServer } from "./bridge.ts";

export async function runAccountCommand(opts: { dataDir: string }): Promise<void> {
  console.log("");
  console.log("  Shuggle keeps one account per device. This creates it (and unlocks it).");
  console.log("  Everything — chats, tokens, memories, settings — lives inside it.");
  console.log("");
  try {
    const bridge = await connectServer(opts.dataDir, { create: true });
    console.log("");
    console.log(`  Account ready on this device. Shuggle is listening on port ${bridge.port}.`);
    console.log("");
    process.exit(0);
  } catch (e: any) {
    console.error(`  ${e?.message ?? e}`);
    process.exit(1);
  }
}
