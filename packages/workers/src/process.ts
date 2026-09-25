export interface ProcessResult {
  exitCode: number | null;
  status: "exited" | "timed-out" | "cancelled" | "spawn-error";
  stdout: string;
  stderr: string;
  error?: string;
  truncated: boolean;
}

export interface ProcessOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Uint8Array) => void | Promise<void>;
  maxCaptureBytes?: number;
}

/** Execute one process with bounded capture and process-group termination. */
export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (options.command.length === 0 || !options.command[0]) throw new Error("Missing executable");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid timeout");
  const limit = options.maxCaptureBytes ?? 64_000;
  if (limit <= 0) throw new Error("Invalid capture limit");
  if (options.signal?.aborted) return { exitCode: null, status: "cancelled", stdout: "", stderr: "", truncated: false };
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(options.command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch {
    return {
      exitCode: null,
      status: "spawn-error",
      stdout: "",
      stderr: "",
      error: "Could not start process",
      truncated: false,
    };
  }
  let status: ProcessResult["status"] = "exited";
  let truncated = false;
  const terminate = (reason: "timed-out" | "cancelled") => {
    if (status !== "exited") return;
    status = reason;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* process already exited */
      }
    }
  };
  const timer = setTimeout(() => terminate("timed-out"), options.timeoutMs);
  const abort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  const capture = async (stream: ReadableStream<Uint8Array>, onChunk?: (chunk: Uint8Array) => void | Promise<void>) => {
    let output = "";
    let bytes = 0;
    const reader = stream.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const available = Math.max(0, limit - bytes);
      if (chunk.byteLength > available) truncated = true;
      if (available) {
        const slice = chunk.subarray(0, available);
        output += new TextDecoder().decode(slice);
        bytes += slice.byteLength;
      }
      if (onChunk) await onChunk(chunk);
    }
    return output;
  };
  const stdout = capture(child.stdout as ReadableStream<Uint8Array>, options.onStdout);
  const stderr = capture(child.stderr as ReadableStream<Uint8Array>);
  try {
    const stdin = child.stdin;
    if (stdin && typeof stdin !== "number") {
      if (options.stdin) stdin.write(options.stdin);
      await stdin.end();
    }
    const [out, err, exitCode] = await Promise.all([stdout, stderr, child.exited]);
    return { exitCode, status, stdout: out, stderr: err, truncated };
  } catch (error) {
    terminate("cancelled");
    await Promise.allSettled([stdout, stderr, child.exited]);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
