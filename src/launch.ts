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

/** Open the UI in a real window (Edge first on Windows — that's WebView2 under
 *  the hood; chromium-family app mode elsewhere). Falls back to the default browser. */
export function openAppWindow(url: string): void {
  const p = process.platform;
  const quiet = { stdio: "ignore", detached: true } as const;
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
          spawn(e, [`--app=${url}`, `--window-size=1280,860`], quiet).unref();
          return;
        }
      }
      spawn("cmd", ["/c", "start", "", url], quiet).unref();
    } else if (p === "darwin") {
      for (const b of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) {
        try {
          spawn(b, [`--app=${url}`, `--window-size=1280,860`], quiet).unref();
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
          spawn(b, [`--app=${url}`, `--window-size=1280,860`], quiet).unref();
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
