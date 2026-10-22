import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

/** What `npm run build` records about the source it built (scripts/build-info.mjs); absent when not built that way. */
export type BuildInfo = {
  /** Release version from a v-tag at or before the commit, or a version given to the build. */
  version?: string;
  /** Full git commit hash. */
  commit?: string;
  /** `git describe` output, such as v1.2.3-4-g80e0418 or v1.2.3-dirty. */
  describe?: string;
};

function readBuildInfo(): BuildInfo {
  let info: BuildInfo = {};
  try {
    const raw = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as Record<string, unknown>;
    for (const key of ["version", "commit", "describe"] as const) {
      const value = raw[key];
      if (typeof value === "string" && /^[\x21-\x7e]{1,100}$/u.test(value)) info = { ...info, [key]: value };
    }
  } catch { /* not built by `npm run build`, such as under the test runner */ }
  // A deploy may name the commit it runs when the build could not see git.
  const commit = process.env.FMSG_MCP_COMMIT?.trim();
  if (commit && /^[0-9a-f]{7,64}$/iu.test(commit)) info = { ...info, commit: commit.toLowerCase() };
  return info;
}

export const PACKAGE_NAME: string = pkg.name;
export const BUILD: BuildInfo = readBuildInfo();
/** The release this server is: the build's version when recorded, otherwise package.json's. */
export const VERSION: string = BUILD.version ?? pkg.version;
/** The short commit hash, when the build recorded one. */
export const COMMIT_SHORT: string | undefined = BUILD.commit?.slice(0, 12);
/** One line naming exactly which build this is, such as `1.2.3 (v1.2.3-4-g80e0418)` or `1.2.3 (commit 80e0418)`. */
export const VERSION_LABEL: string = BUILD.describe && BUILD.describe !== `v${VERSION}`
  ? `${VERSION} (${BUILD.describe})`
  : COMMIT_SHORT ? `${VERSION} (commit ${COMMIT_SHORT})` : VERSION;
