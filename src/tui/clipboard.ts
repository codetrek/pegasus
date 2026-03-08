/**
 * Clipboard — copy text to system clipboard.
 *
 * Uses OSC 52 escape sequence (works over SSH, tmux, most modern terminals)
 * plus native OS command fallback.
 */
import { platform } from "os"

/** Write text to clipboard via OSC 52 escape sequence. */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  process.stdout.write(osc52)
}

/** Try native OS clipboard command. */
async function writeNative(text: string): Promise<void> {
  const os = platform()
  const candidates: string[][] =
    os === "darwin" ? [["pbcopy"]] :
    os === "win32"  ? [["powershell.exe", "-NonInteractive", "-NoProfile", "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"]] :
    [
      ...(process.env["WAYLAND_DISPLAY"] ? [["wl-copy"]] : []),
      ["xclip", "-selection", "clipboard"],
      ["xsel", "--clipboard", "--input"],
    ]

  for (const cmd of candidates) {
    try {
      if (!Bun.which(cmd[0]!)) continue
      const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
      proc.stdin!.write(text)
      proc.stdin!.end()
      await proc.exited
      if (proc.exitCode === 0) return
    } catch {
      continue
    }
  }
}

/** Copy text to clipboard. OSC 52 + native fallback. */
export async function copyToClipboard(text: string): Promise<void> {
  writeOsc52(text)
  await writeNative(text)
}
