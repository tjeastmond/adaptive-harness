import {
  type ContextAssembler,
  type ContextAssembly,
  type ContextAssemblyRequest,
  DeterministicContextAssembler,
} from "@adaptive-harness/core";
import type { SqliteHarnessStore } from "./store.ts";

/** Uses the canonical persisted chunks and records every successful assembly. */
export class RecordingContextAssembler implements ContextAssembler {
  readonly #delegate: DeterministicContextAssembler;

  constructor(
    private readonly store: SqliteHarnessStore,
    options?: { maxChunks?: number; maxCharacters?: number },
  ) {
    this.#delegate = new DeterministicContextAssembler(store, options);
  }

  async assemble(request: ContextAssemblyRequest): Promise<ContextAssembly> {
    const assembly = await this.#delegate.assemble(request);
    await this.store.recordContextAssembly(request, assembly);
    return assembly;
  }
}
