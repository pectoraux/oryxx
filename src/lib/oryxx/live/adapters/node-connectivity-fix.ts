// ORYXX — Node.js runtime connectivity fix.
//
// Background: Node 18+ ships a built-in `fetch` (undici). When a target host
// has both AAAA (IPv6) and A (IPv4) DNS records, undici uses Happy Eyeballs
// (RFC 8305) to race both. On networks with no IPv6 egress (common in cloud
// sandboxes and many production VPCs), the IPv6 SYN silently fails and undici
// may surface a generic "fetch failed" / ETIMEDOUT without cleanly falling
// back to IPv4 — observed in this project against the OSRM demo server
// (`router.project-osrm.org` → `routing.openstreetmap.de`, which has an
// AAAA record `2a02:418:39aa:8::7`).
//
// Fix: tell Node to (a) prefer IPv4 in DNS result order and (b) disable
// auto-select-family so the connect attempt uses the IPv4 address first.
// This is a standard, well-documented Node.js fix.
//
// Bun's fetch and curl are not affected — they already implement Happy
// Eyeballs with proper fallback. This module is Node-only; under Bun the
// `node:dns` / `node:net` APIs exist but the calls are no-ops (Bun's fetch
// already does the right thing), and under the browser these imports would
// be excluded by the bundler because this file is only ever imported by
// server-side adapters (it is never imported from a client component).
//
// Idempotent: safe to import from multiple modules. The defaults are set
// once per process.

import * as dns from "node:dns";
import * as net from "node:net";

let applied = false;

export function applyNodeConnectivityFix(): void {
  if (applied) return;
  applied = true;

  try {
    // Prefer IPv4 in resolution order — fixes the "fetch failed / ETIMEDOUT"
    // pattern on hosts with AAAA records when IPv6 egress is unavailable.
    const dnsMod = dns as unknown as {
      setDefaultResultOrder?: (order: "ipv4first" | "verbatim") => void;
    };
    if (typeof dnsMod.setDefaultResultOrder === "function") {
      dnsMod.setDefaultResultOrder("ipv4first");
    }

    // Disable auto-select-family so Node uses the first resolved address
    // (IPv4 in our case) instead of racing both families.
    const netMod = net as unknown as {
      setDefaultAutoSelectFamily?: (enabled: boolean) => void;
    };
    if (typeof netMod.setDefaultAutoSelectFamily === "function") {
      netMod.setDefaultAutoSelectFamily(false);
    }
  } catch {
    // If the runtime does not expose these APIs (older Node), no-op.
    // The adapter's own failure handling will return [] / null on
    // connect failures, so the system degrades safely.
  }
}

// Apply once at module load. Subsequent imports are free.
applyNodeConnectivityFix();
