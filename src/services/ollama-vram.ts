// Free the local Ollama model's VRAM while ComfyUI generates.
//
// On a single-GPU box the local agent (Ollama) and ComfyUI fight for VRAM: a
// resident chat model can OOM a render, and a chat sent mid-render reloads the
// model on top of the running generation (the field report that motivated
// this). Ollama unloads a model immediately when a request carries
// `keep_alive: 0`, and re-loads it when a request carries a normal keep_alive —
// verified live: {keep_alive:0} → done_reason "unload" (/api/ps then empty),
// {keep_alive:"5m"} → done_reason "load" (model resident again).
//
// Everything here is BEST-EFFORT: any failure (Ollama down, timeout) is logged
// and swallowed — freeing/warming VRAM must never break a turn or a render.

import { logger } from "../utils/logger.js";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/** Normalize an Ollama host (env OLLAMA_HOST may lack a scheme / have a slash). */
export function resolveOllamaHost(host?: string): string {
  const raw = (host || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).trim();
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

interface PsModel {
  name?: string;
  model?: string;
  size_vram?: number;
}

/** Models Ollama currently holds in VRAM (from /api/ps). */
async function loadedModels(host: string): Promise<string[]> {
  try {
    const res = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: PsModel[] };
    return (data.models ?? [])
      .filter((m) => (m.size_vram ?? 0) > 0)
      .map((m) => m.model || m.name || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Immediately unload EVERY resident Ollama model (keep_alive:0) to free VRAM
 *  for a render. Returns the models it asked to unload. */
export async function unloadAllOllama(host: string): Promise<string[]> {
  const h = resolveOllamaHost(host);
  const models = await loadedModels(h);
  if (models.length === 0) return [];
  await Promise.all(
    models.map(async (model) => {
      try {
        await fetch(`${h}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, keep_alive: 0 }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        logger.debug(
          `[ollama-vram] unload ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
  logger.info(`[ollama-vram] unloaded ${models.length} model(s) to free VRAM: ${models.join(", ")}`);
  return models;
}

/** Re-load a model into VRAM (normal keep_alive) so the agent is responsive
 *  again the moment a render finishes — a no-prompt /api/generate just loads. */
export async function warmOllama(host: string, model: string, keepAlive: string = "10m"): Promise<boolean> {
  if (!model) return false;
  const h = resolveOllamaHost(host);
  try {
    const res = await fetch(`${h}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: keepAlive }),
      signal: AbortSignal.timeout(120000), // a cold load of a big model can take a while
    });
    if (res.ok) {
      logger.info(`[ollama-vram] warmed ${model} back into VRAM`);
      return true;
    }
  } catch (err) {
    logger.debug(
      `[ollama-vram] warm ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return false;
}
