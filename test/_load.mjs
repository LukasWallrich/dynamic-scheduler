import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const core = join(dirname(fileURLToPath(import.meta.url)), "..", "core");

for (const f of ["universe", "votes", "constraints", "engine", "pivot", "text"]) {
  require(join(core, f + ".js"));
}

export const Sched = globalThis.Sched;
