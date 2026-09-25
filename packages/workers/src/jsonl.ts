/**
 * Parses untrusted JSONL without retaining an unbounded line or event history. Lines over `maxLineBytes` are
 * dropped unparsed and counted in `oversizedCount`; lines that are not JSON are counted in `invalidCount`.
 */
export class BoundedJsonlParser {
  private buffer = "";
  private dropping = false;
  private readonly decoder = new TextDecoder();
  invalidCount = 0;
  oversizedCount = 0;
  lineCount = 0;

  constructor(
    private readonly onValue: (value: unknown) => void | Promise<void>,
    readonly maxLineBytes = 64_000,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    await this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  async finish(): Promise<void> {
    await this.consume(this.decoder.decode());
    if (this.buffer && !this.dropping) await this.line(this.buffer);
    else if (this.dropping) this.oversizedCount++;
    this.buffer = "";
  }

  private async consume(text: string): Promise<void> {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      if (!this.dropping) {
        this.buffer += part;
        if (Buffer.byteLength(this.buffer) > this.maxLineBytes) {
          this.buffer = "";
          this.dropping = true;
        }
      }
      if (i < parts.length - 1) {
        if (this.dropping) this.oversizedCount++;
        else await this.line(this.buffer.replace(/\r$/, ""));
        this.buffer = "";
        this.dropping = false;
      }
    }
  }

  private async line(line: string): Promise<void> {
    if (!line.trim()) return;
    this.lineCount++;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.invalidCount++;
      return;
    }
    await this.onValue(value);
  }
}
