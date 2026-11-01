// Shuggle — window launching + URL helpers.

import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { existsSync } from "node:fs";

export async function pickFreePort(preferred = 8680): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    if (await isFree(p)) return p;
  }
  return 0; // let the OS pick
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export function localUrls(port: number): string[] {
  return [`http://127.0.0.1:${port}`];
}

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  if (urls.length === 0) urls.push(`http://127.0.0.1:${port}`);
  return urls;
}

/**
 * Windows: detach from the console so no cmd box is left behind the window.
 *
 * The binary keeps the console subsystem on purpose — the CLI modes (cli /
 * chat / tokens / status) must print to the terminal. Only the window mode
 * detaches, and it does so before anything else runs, so the console window
 * disappears immediately instead of hanging around in the background.
 */
export async function detachConsole(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      FreeConsole: { args: [], returns: FFIType.void },
    });
    kernel32.symbols.FreeConsole();
  } catch {
    /* no console attached — nothing to detach */
  }
}

/** Open the UI in a real window (Edge first on Windows — that's WebView2 under
 *  the hood; chromium-family app mode elsewhere). Falls back to the default browser.
 *  `useEdgeData` (Windows): when ON, the window shares the user's real Edge
 *  profile (history, cookies). When OFF (default) it runs in a private profile
 *  folder next to the app, so Shuggle never touches their browser data. */
export function openAppWindow(url: string, opts: { useEdgeData?: boolean; userDataDir?: string } = {}): void {
  const p = process.platform;
  const quiet = { stdio: "ignore", detached: true } as const;
  const flags = [`--app=${url}`, "--window-size=1280,860", "--no-first-run", "--no-default-browser-check"];
  try {
    if (p === "win32") {
      const edges = [
        `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      ];
      for (const e of edges) {
        if (existsSync(e)) {
          const extra = opts.useEdgeData ? [] : ["--user-data-dir=" + (opts.userDataDir ?? "")];
          spawn(e, [...flags, ...extra.filter(Boolean)], quiet).unref();
          return;
        }
      }
      spawn("cmd", ["/c", "start", "", url], quiet).unref();
    } else if (p === "darwin") {
      for (const b of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) {
        try {
          spawn(b, flags, quiet).unref();
          return;
        } catch {
          /* next */
        }
      }
      spawn("open", [url], quiet).unref();
    } else {
      // Linux: chromium-family app mode, then firefox, then whatever opens URLs.
      for (const b of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "microsoft-edge"]) {
        try {
          const extra = opts.useEdgeData ? [] : ["--user-data-dir=" + (opts.userDataDir ?? "")];
          spawn(b, [...flags, ...extra.filter(Boolean)], quiet).unref();
          return;
        } catch {
          /* next */
        }
      }
      try {
        spawn("xdg-open", [url], quiet).unref();
      } catch {
        /* user will open the printed URL */
      }
    }
  } catch {
    /* never crash the app because a window didn't open */
  }
}
