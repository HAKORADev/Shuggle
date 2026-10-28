import { VERSION } from "./version.ts";

const GRADIENT = ["\x1b[38;5;177m", "\x1b[38;5;176m", "\x1b[38;5;175m", "\x1b[38;5;174m", "\x1b[38;5;210m", "\x1b[38;5;209m", "\x1b[38;5;203m"];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const LINES = [
  "  ███████╗██╗  ██╗██╗   ██╗ ██████╗ ██████╗ ██╗     ██╗     ███████╗",
  "  ██╔════╝██║  ██║██║   ██║██╔════╝██╔═══██╗██║     ██║     ██╔════╝",
  "  ███████╗███████║██║   ██║██║     ██║   ██║██║     ██║     █████╗  ",
  "  ╚════██║██╔══██║╚██╗ ██╔╝██║     ██║   ██║██║     ██║     ██╔══╝  ",
  "  ███████║██║  ██║ ╚████╔╝ ╚██████╗╚██████╔╝███████╗███████╗███████╗",
  "  ╚══════╝╚═╝  ╚═╝  ╚═══╝   ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚══════╝",
];

export function banner(): string {
  const out: string[] = [];
  const supportsColor = process.env.FORCE_COLOR !== "0" && !process.env.NO_COLOR;
  LINES.forEach((line, i) => {
    if (supportsColor) {
      const c = GRADIENT[Math.min(i, GRADIENT.length - 1)];
      out.push(c + line + RESET);
    } else {
      out.push(line);
    }
  });
  if (supportsColor) {
    out.push("");
    out.push(`  ${DIM}free chats on free GPUs — uncensored, private, yours${RESET}`);
    out.push(`  ${DIM}v${VERSION} · HAKORA${RESET}`);
  } else {
    out.push("");
    out.push(`  free chats on free GPUs — uncensored, private, yours`);
    out.push(`  v${VERSION} · HAKORA`);
  }
  return out.join("\n");
}

export function printBanner(): void {
  console.log(banner());
}
