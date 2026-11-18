import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { boundEnvironment, environmentFingerprint, type EnvironmentManifest } from "./environment-runtime.mjs";

// Repeated uploads of the same evidence reuse its original observation time.
// Atomic links also make two concurrent shares choose the same snapshot.
export async function pinEnvironment(
  directory: string, raw: Buffer, otherExtensions: Record<string, any>, captured: EnvironmentManifest,
): Promise<EnvironmentManifest> {
  const environment = boundEnvironment(captured, otherExtensions);
  const key = crypto.createHash("sha256").update(raw).update(JSON.stringify(otherExtensions))
    .update(environmentFingerprint(environment)).digest("hex");
  const file = path.join(directory, key + ".json");
  let temporary: string | undefined;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = path.join(directory, "." + crypto.randomUUID());
    await fs.writeFile(temporary, JSON.stringify(environment), { mode: 0o600, flag: "wx" });
    try { await fs.link(temporary, file); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    const recorded = JSON.parse(await fs.readFile(file, "utf8"));
    if (environmentFingerprint(recorded) === environmentFingerprint(environment)) return recorded;
  } catch { /* A local cache failure must not prevent archiving the task. */ }
  finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
  return environment;
}
