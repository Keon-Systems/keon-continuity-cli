/**
 * Clipboard copy for the web-chat bridge: `continuity briefing --clipboard` puts the briefing on
 * the clipboard so the user can paste it into claude.ai / ChatGPT / Gemini, where the CLI cannot
 * run. Detection is best-effort across platforms; `CONTINUITY_CLIPBOARD` overrides it (a command
 * run via `sh -c` that reads the text from stdin) so tests and headless setups are deterministic.
 * A failed copy is an error, never a silent fall-through: "on the clipboard" must mean on the clipboard.
 */

import { spawnSync } from "node:child_process";

export class ClipboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipboardError";
  }
}

/** First installed tool wins. Each gets the text on stdin. */
export const CLIPBOARD_CANDIDATES: { tool: string; args: string[] }[] = [
  { tool: "pbcopy", args: [] }, // macOS
  { tool: "wl-copy", args: [] }, // Wayland
  { tool: "xclip", args: ["-selection", "clipboard"] }, // X11
  { tool: "xsel", args: ["--clipboard", "--input"] }, // X11
  { tool: "clip.exe", args: [] }, // WSL
];

export function copyToClipboard(text: string): { tool: string } {
  const override = process.env.CONTINUITY_CLIPBOARD?.trim();
  if (override) {
    const r = spawnSync("sh", ["-c", override], { input: text, encoding: "utf8" });
    if (r.error) throw new ClipboardError(`clipboard command failed: ${r.error.message}`);
    if (r.status !== 0) throw new ClipboardError(`clipboard command "${override}" exited ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ""}`);
    return { tool: override };
  }
  const tried: string[] = [];
  for (const { tool, args } of CLIPBOARD_CANDIDATES) {
    const r = spawnSync(tool, args, { input: text, encoding: "utf8" });
    if (r.error) {
      tried.push(tool); // not installed
      continue;
    }
    if (r.status !== 0) {
      tried.push(`${tool} (exit ${r.status})`); // installed but no display / refused
      continue;
    }
    return { tool };
  }
  throw new ClipboardError(`no clipboard tool worked (tried: ${tried.join(", ")}). Install one (wl-copy, xclip, xsel, pbcopy) or copy manually from \`continuity briefing\`.`);
}
