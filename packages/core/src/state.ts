import { createHash } from "node:crypto";
import type {
  ContextAssembler,
  ContextAssembly,
  ContextAssemblyRequest,
  StateChunk,
  StateChunkId,
  StateChunkType,
  StateStore,
} from "./types.ts";

/** Keeps append order within each run and isolates callers from stored values. */
export class InMemoryStateStore implements StateStore {
  private readonly chunks = new Map<StateChunkId, StateChunk>();
  private readonly runIds = new Map<string, StateChunkId[]>();

  async append(chunk: StateChunk): Promise<void> {
    if (!chunk.id || !chunk.runId) throw new Error("State chunks require an id and runId");
    if (this.chunks.has(chunk.id)) throw new Error(`State chunk already exists: ${chunk.id}`);

    this.chunks.set(chunk.id, structuredClone(chunk));
    const ids = this.runIds.get(chunk.runId) ?? [];
    ids.push(chunk.id);
    this.runIds.set(chunk.runId, ids);
  }

  async get(id: StateChunkId): Promise<StateChunk | undefined> {
    const chunk = this.chunks.get(id);
    return chunk === undefined ? undefined : structuredClone(chunk);
  }

  async list(
    runId: string,
    options?: { types?: StateChunkType[]; ids?: StateChunkId[]; limit?: number },
  ): Promise<StateChunk[]> {
    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new Error("State chunk limit must be a nonnegative integer");
    }

    const allowedTypes = options?.types && new Set(options.types);
    const allowedIds = options?.ids && new Set(options.ids);
    const chunks = (this.runIds.get(runId) ?? [])
      .map((id) => {
        const chunk = this.chunks.get(id);
        if (!chunk) throw new Error(`Missing state chunk: ${id}`);
        return chunk;
      })
      .filter((chunk) => (!allowedTypes || allowedTypes.has(chunk.type)) && (!allowedIds || allowedIds.has(chunk.id)));
    const selected = options?.limit === undefined ? chunks : options.limit === 0 ? [] : chunks.slice(-options.limit);
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
    const selected = this.maxChunks === 0 ? [] : eligible.slice(-this.maxChunks).reverse();
    const objective = [
      "OBJECTIVE",
      request.objective.text,
      "ACCEPTANCE CRITERIA",
      ...request.objective.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ].join("\n");
    const boundedObjective = objective.slice(0, this.maxCharacters);
    let remaining = this.maxCharacters - boundedObjective.length;
    const renderedChunks: Array<{ selected: ContextAssembly["chunks"][number]; text: string }> = [];

    for (const chunk of selected) {
      const heading = `\n\nSTATE CHUNK ${chunk.id} (${chunk.type}; ${chunk.source})\n`;
      if (heading.length >= remaining) break;
      const content = typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content);
      if (content === undefined) throw new Error(`State chunk has no renderable content: ${chunk.id}`);
      const rendered = content.slice(0, remaining - heading.length);
      const text = heading + rendered;
      remaining -= text.length;
      renderedChunks.push({
        selected: { chunk, visibility: rendered.length < content.length ? "short" : "full" },
        text,
      });
      if (rendered.length < content.length) break;
    }

    renderedChunks.reverse();
    const summary = boundedObjective + renderedChunks.map(({ text }) => text).join("");

    return {
      chunks: renderedChunks.map(({ selected }) => selected),
      summary,
      renderedContentHash: createHash("sha256").update(summary).digest("hex"),
    };
  }
}
