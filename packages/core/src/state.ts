import { createHash } from "node:crypto";
import type {
  ContextAssembler,
  ContextAssembly,
  ContextAssemblyRequest,
  StateChunk,
  StateChunkId,
  StateListOptions,
  StateStore,
} from "./types.ts";

type RenderedChunk = ContextAssembly["chunks"][number] & { text: string };

/** The last `n` items; unlike `slice(-n)`, `n = 0` yields none. */
function lastN<T>(items: readonly T[], n: number): T[] {
  return n === 0 ? [] : items.slice(-n);
}

/** Keeps append order within each run and isolates callers from stored values. */
export class InMemoryStateStore implements StateStore {
  private readonly chunks = new Map<StateChunkId, StateChunk>();
  private readonly chunkIdsByRun = new Map<string, StateChunkId[]>();

  async append(chunk: StateChunk): Promise<void> {
    if (!chunk.id || !chunk.runId) throw new Error("State chunks require an id and runId");
    if (this.chunks.has(chunk.id)) throw new Error(`State chunk already exists: ${chunk.id}`);

    this.chunks.set(chunk.id, structuredClone(chunk));
    const ids = this.chunkIdsByRun.get(chunk.runId) ?? [];
    ids.push(chunk.id);
    this.chunkIdsByRun.set(chunk.runId, ids);
  }

  async get(id: StateChunkId): Promise<StateChunk | undefined> {
    const chunk = this.chunks.get(id);
    return chunk === undefined ? undefined : structuredClone(chunk);
  }

  async list(runId: string, options?: StateListOptions): Promise<StateChunk[]> {
    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new Error("State chunk limit must be a nonnegative integer");
    }

    const allowedTypes = options?.types && new Set(options.types);
    const allowedIds = options?.ids && new Set(options.ids);
    const chunks = (this.chunkIdsByRun.get(runId) ?? [])
      .map((id) => {
        const chunk = this.chunks.get(id);
        if (!chunk) throw new Error(`Missing state chunk: ${id}`);
        return chunk;
      })
      .filter((chunk) => (!allowedTypes || allowedTypes.has(chunk.type)) && (!allowedIds || allowedIds.has(chunk.id)));
    const selected = options?.limit === undefined ? chunks : lastN(chunks, options.limit);
    return selected.map((chunk) => structuredClone(chunk));
  }
}

export interface DeterministicContextOptions {
  maxChunks?: number;
  maxCharacters?: number;
}

/** Prioritizes recent chunks, then renders the selected chunks in append order. */
export class DeterministicContextAssembler implements ContextAssembler {
  private readonly maxChunks: number;
  private readonly maxCharacters: number;

  constructor(
    private readonly store: StateStore,
    options: DeterministicContextOptions = {},
  ) {
    this.maxChunks = options.maxChunks ?? 16;
    this.maxCharacters = options.maxCharacters ?? 12_000;
    if (!Number.isInteger(this.maxChunks) || this.maxChunks < 0) throw new Error("maxChunks must be nonnegative");
    if (!Number.isInteger(this.maxCharacters) || this.maxCharacters < 128) {
      throw new Error("maxCharacters must be an integer of at least 128");
    }
  }

  async assemble(request: ContextAssemblyRequest): Promise<ContextAssembly> {
    const candidates = await this.store.list(
      request.runId,
      request.candidateChunkIds === undefined ? undefined : { ids: request.candidateChunkIds },
    );
    const candidateIds = request.candidateChunkIds && new Set(request.candidateChunkIds);
    const eligible = candidates.filter((chunk) => !candidateIds || candidateIds.has(chunk.id));
    const objective = [
      "OBJECTIVE",
      request.objective.text,
      "ACCEPTANCE CRITERIA",
      ...request.objective.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ]
      .join("\n")
      .slice(0, this.maxCharacters);
    const rendered = this.fit(lastN(eligible, this.maxChunks).reverse(), this.maxCharacters - objective.length);
    const summary = objective + rendered.map(({ text }) => text).join("");

    return {
      chunks: rendered.map(({ chunk, visibility }) => ({ chunk, visibility })),
      summary,
      renderedContentHash: createHash("sha256").update(summary).digest("hex"),
    };
  }

  /** Renders newest-first chunks into `budget` characters, stopping at the first truncated one; returns append order. */
  private fit(newestFirst: StateChunk[], budget: number): RenderedChunk[] {
    let remaining = budget;
    const rendered: RenderedChunk[] = [];
    for (const chunk of newestFirst) {
      const heading = `\n\nSTATE CHUNK ${chunk.id} (${chunk.type}; ${chunk.source})\n`;
      if (heading.length >= remaining) break;
      const content = typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content);
      if (content === undefined) throw new Error(`State chunk has no renderable content: ${chunk.id}`);
      const body = content.slice(0, remaining - heading.length);
      const truncated = body.length < content.length;
      const text = heading + body;
      remaining -= text.length;
      rendered.push({ chunk, visibility: truncated ? "short" : "full", text });
      if (truncated) break;
    }
    return rendered.reverse();
  }
}
