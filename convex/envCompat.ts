// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Deployment env vars were renamed ATLAS_* → BHAI_*. The live deployment still
// has the ATLAS_ names, so read the new name first and fall back to the old one.
export function bhaiEnv(name: string): string | undefined {
  return process.env[`BHAI_${name}`] ?? process.env[`ATLAS_${name}`];
}
