import { existsSync } from "node:fs";
import { basename } from "node:path";
import { networkInterfaces } from "node:os";
import { envFiles } from "./watchEnv";
import pkg from "../package.json";

// "GEMI" — ANSI Shadow figlet font.
const ART = [
  " ██████╗ ███████╗███╗   ███╗██╗",
  "██╔════╝ ██╔════╝████╗ ████║██║",
  "██║  ███╗█████╗  ██╔████╔██║██║",
  "██║   ██║██╔══╝  ██║╚██╔╝██║██║",
  "╚██████╔╝███████╗██║ ╚═╝ ██║██║",
  " ╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝",
];

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, text: string) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const cyan = (t: string) => paint("36", t);
const green = (t: string) => paint("32", t);
const magenta = (t: string) => paint("35", t);

function gemiVersion(): string {
  return (pkg as { version?: string }).version ?? "?";
}

function networkUrl(port: number | string): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      // Node <18 reported `family` as the number 4; newer Bun/Node use "IPv4".
      const isV4 = iface.family === "IPv4" || (iface.family as unknown) === 4;
      if (isV4 && !iface.internal) return `http://${iface.address}:${port}`;
    }
  }
  return null;
}

function loadedEnvFiles(rootDir: string): string[] {
  return envFiles(rootDir)
    .filter((file) => existsSync(file))
    .map((file) => basename(file));
}

export function printStartupBanner(params: {
  port: number | string;
  rootDir: string;
}) {
  const { port, rootDir } = params;
  const local = `http://localhost:${port}`;
  const network = networkUrl(port);
  const env = loadedEnvFiles(rootDir);

  const row = (label: string, value: string) =>
    `  ${green("➜")}  ${bold(label.padEnd(9))}${value}`;

  const out = [
    "",
    ...ART.map((line) => magenta(line)),
    "",
    `  ${dim("gemi")} ${cyan(`v${gemiVersion()}`)}`,
    "",
    row("Local:", cyan(local)),
    row("Network:", network ? cyan(network) : dim("unavailable")),
    row("Env:", env.length ? env.join(", ") : dim("none")),
    "",
  ];

  console.log(out.join("\n"));
}
