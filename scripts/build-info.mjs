// Records which source a build came from in dist/build-info.json, so whoami and /healthz can name the exact build.
// Sources, in order: FMSG_MCP_VERSION / FMSG_MCP_COMMIT (Docker build args, CI), then git when the checkout has it.
// Missing information is left out; the server then reports package.json's version alone.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const git = (...args) => {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
  catch { return undefined; }
};
const tag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
const info = {
  version: process.env.FMSG_MCP_VERSION?.trim().replace(/^v/u, "") || tag?.replace(/^v/u, ""),
  commit: process.env.FMSG_MCP_COMMIT?.trim().toLowerCase() || git("rev-parse", "HEAD"),
  describe: git("describe", "--tags", "--match", "v[0-9]*", "--always"),
};
if (info.version && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(info.version)) throw new Error(`build-info: invalid version ${info.version}`);
if (info.commit && !/^[0-9a-f]{7,64}$/u.test(info.commit)) throw new Error(`build-info: invalid commit ${info.commit}`);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/build-info.json", `${JSON.stringify(Object.fromEntries(Object.entries(info).filter(([, v]) => v)), null, 2)}\n`);
