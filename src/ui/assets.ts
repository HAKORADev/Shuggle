// Shuggle — the web UI, embedded INTO the executable.
//
// A single-file build has no src/ui folder on disk. Reading the assets from
// the filesystem (as the first version did) means the shipped app opens a
// BLANK WINDOW — every asset comes back empty. Importing them with the
// "text" import attribute bakes them into the binary, so the app works the
// same from source and from the compiled single file.
//
// The UI bundle (app.bundle.js) is generated from src/ui/app.ts by
// `bun run build:ui` — that runs before every build.

import indexHtml from "./index.html" with { type: "text" };
import styleCss from "./style.css" with { type: "text" };
import appJs from "./app.bundle.js" with { type: "text" };
import markedJs from "./vendor/marked.min.js" with { type: "text" };
import purifyJs from "./vendor/purify.min.js" with { type: "text" };
import hljsJs from "./vendor/highlight.min.js" with { type: "text" };
import hljsCss from "./vendor/highlight-theme.css" with { type: "text" };
import faviconSvg from "../../assets/shuggle.svg" with { type: "text" };

export const assets = {
  indexHtml,
  styleCss,
  appJs,
  markedJs,
  purifyJs,
  hljsJs,
  hljsCss,
  faviconSvg,
};

/** True when the UI is actually there — a blank window is worse than an error. */
export function assetsPresent(): boolean {
  return !!(indexHtml && indexHtml.includes("<div id=\"app\">") && appJs && appJs.length > 1000);
}
