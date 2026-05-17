// F14: in-memory per-IP rate limiter. Sufficient for single-process Next.js
// deployments. For multi-replica deployments, swap for Redis-backed limiter
// (Upstash / Vercel KV). The shape is intentionally small so a swap is easy.
//
// Window is a sliding 60s; each IP gets `max` attempts. When a bucket
// overflows we return ok:false with a retry-after-ish reset time so the
// caller can include it in a 429 response.

const buckets = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 60_000;

// Background sweep — runs once every 5 minutes — keeps the map bounded.
// Without this, a stream of unique IPs would grow buckets unbounded.
let sweepTimer: NodeJS.Timeout | null = null;
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    buckets.forEach((b, key) => {
      if (b.resetAt < now) buckets.delete(key);
    });
  }, 300_000);
  // Don't keep the Node event loop alive just for this.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export function checkRateLimit(key: string, max: number, windowMs = WINDOW_MS): RateLimitResult {
  ensureSweep();
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt < now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: true, remaining: max - 1, resetAt };
  }
  if (existing.count >= max) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count++;
  return { ok: true, remaining: max - existing.count, resetAt: existing.resetAt };
}

// Extract the caller IP from common reverse-proxy headers. Fall back to the
// raw `request.ip` (Next 14+). NEVER trust the IP from the body.
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  // Next 13 NextRequest exposes `ip`; cast through unknown so it compiles
  // against the generic Request type too.
  const r = req as unknown as { ip?: string };
  return r.ip || "unknown";
}
