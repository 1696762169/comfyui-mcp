import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/** Default cap on how long we wait for a workflow URL to respond. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Default cap on the workflow payload size (workflows are JSON, rarely > a few MB). */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Known "share" hosts that serve an HTML page (or require an authenticated API
 * call) rather than raw workflow JSON. We can't resolve these to a graph, so we
 * fail fast with a clear instruction instead of fetching a web page and choking
 * on the HTML.
 */
const UNSUPPORTED_SHARE_HOSTS = [
  "comfyworkflows.com",
  "openart.ai",
  "civitai.com",
  "comfy.icu",
  "pixfor.us",
];

export interface FetchWorkflowResult {
  /** Parsed JSON payload (unknown shape — caller validates it's a workflow). */
  json: unknown;
  /** The final URL actually fetched (after blob→raw normalization). */
  finalUrl: string;
}

/**
 * Normalize well-known workflow URLs to their raw-JSON equivalent, and reject
 * share hosts we can't resolve.
 *
 * - GitHub blob pages (`github.com/o/r/blob/ref/path.json`) → the raw file on
 *   `raw.githubusercontent.com`.
 * - GitHub `?raw=true` blob links → raw host too.
 * - Known share hosts (comfyworkflows, openart, civitai, …) → throw with a hint
 *   to paste the raw `.json` URL.
 *
 * Anything else is returned unchanged.
 */
export function normalizeWorkflowUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    // Leave parsing/validation errors to assertSafeUrl, which gives a better message.
    return rawUrl;
  }

  const host = u.hostname.toLowerCase();

  // github.com/<owner>/<repo>/blob/<ref>/<path...> → raw.githubusercontent.com
  if (host === "github.com" || host === "www.github.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    const blobIdx = parts.indexOf("blob");
    if (blobIdx >= 2 && blobIdx < parts.length - 1) {
      const owner = parts[0];
      const repo = parts[1];
      const rest = parts.slice(blobIdx + 1).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
    }
  }

  // Refuse share hosts that don't serve raw JSON.
  if (
    UNSUPPORTED_SHARE_HOSTS.some((h) => host === h || host.endsWith("." + h))
  ) {
    throw new ValidationError(
      `Unsupported share host "${host}" — it serves a web page, not raw workflow JSON, ` +
        `and we can't resolve it without that site's API. Open the workflow there, then paste ` +
        `the direct raw .json URL (e.g. a raw.githubusercontent.com link or a "Save (API Format)" ` +
        `export hosted as a .json file).`,
    );
  }

  return rawUrl;
}

/**
 * Reject any URL that isn't a plain http(s) request to a public host. Blocks
 * file:// and other schemes, loopback, link-local, private, and CGNAT ranges to
 * avoid SSRF (e.g. tricking the server into fetching its own /admin or the cloud
 * metadata endpoint at 169.254.169.254).
 *
 * Note: this checks the literal host/IP in the URL. It does not resolve DNS, so
 * a public hostname that resolves to a private IP (DNS rebinding) is not caught
 * here — redirects are followed by fetch and are likewise not re-validated.
 */
export function assertSafeUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ValidationError(`Invalid URL: ${rawUrl}`);
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ValidationError(
      `Only http/https URLs are supported (got "${u.protocol}"). ` +
        `file://, data:, and other schemes are rejected.`,
    );
  }

  const host = u.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    throw new ValidationError(
      `Refusing to fetch from internal/loopback host "${host}" (SSRF guard). ` +
        `Only public http/https hosts are allowed.`,
    );
  }

  return u;
}

/**
 * True for hostnames/IPs that point at the local machine or a private network.
 * Exported for unit testing.
 */
export function isBlockedHost(host: string): boolean {
  if (!host) return true;

  // Hostname-based internal names.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  // IPv6 (URL.hostname strips the surrounding brackets).
  if (host.includes(":")) {
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    const low = h.toLowerCase();
    // Unique-local fc00::/7 (fc.. / fd..) and link-local fe80::/10 (fe8/fe9/fea/feb).
    if (/^f[cd]/.test(low)) return true;
    if (/^fe[89ab]/.test(low)) return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) — extract the trailing v4 literal.
    const v4 = low.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return isBlockedIpv4(v4[1]);
    return false;
  }

  // IPv4 literal.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return isBlockedIpv4(host);
  }

  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n > 255)) {
    return true; // malformed → reject
  }
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Fetch and JSON-parse a workflow from a remote URL with SSRF, timeout, and
 * size guards. Throws ValidationError (never a raw fetch error) on any failure
 * so callers can surface a clean message via errorToToolResult.
 */
export async function fetchWorkflowFromUrl(
  rawUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<FetchWorkflowResult> {
  const normalized = normalizeWorkflowUrl(rawUrl);
  const u = assertSafeUrl(normalized);

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(u, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
    });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "AbortError") {
      throw new ValidationError(
        `Timed out after ${timeoutMs}ms fetching workflow from "${u.hostname}".`,
      );
    }
    throw new ValidationError(`Failed to fetch workflow URL: ${e?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ValidationError(
      `Workflow URL returned ${res.status} ${res.statusText}. ` +
        `Check the link points at a public raw .json file.`,
    );
  }

  // Pre-flight size check via Content-Length when present.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) {
    throw new ValidationError(
      `Workflow payload too large (${declared} bytes > ${maxBytes} byte limit).`,
    );
  }

  const text = await res.text();
  if (text.length > maxBytes) {
    throw new ValidationError(
      `Workflow payload too large (${text.length} bytes > ${maxBytes} byte limit).`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new ValidationError(
      `URL did not return valid JSON (got: "${preview}…"). ` +
        `If this is a share/preview page, paste the raw workflow JSON URL instead.`,
    );
  }

  logger.info("Fetched workflow from URL", { finalUrl: u.toString(), bytes: text.length });
  return { json, finalUrl: u.toString() };
}
