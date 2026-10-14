export interface SubtitleCue {
  index: string;
  start: string;
  end: string;
  text: string;
}

const TIMESTAMP_LINE =
  /^\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?\s*$/;

export function parseSrt(input: string): SubtitleCue[] {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    throw new Error("SRT файл хоосон байна.");
  }

  const blocks = normalized.split(/\n[ \t]*\n+/);
  const cues = blocks.map((block, blockPosition) => {
    const lines = block.split("\n");
    let firstLine = 0;
    while (firstLine < lines.length && !lines[firstLine].trim()) firstLine += 1;

    const index = lines[firstLine]?.trim();
    const timestampLine = lines[firstLine + 1];
    const match = timestampLine?.match(TIMESTAMP_LINE);
    const text = lines.slice(firstLine + 2).join("\n").replace(/^\s+|\s+$/g, "");

    if (!index || !/^\d+$/.test(index) || !match || !text) {
      throw new Error(`SRT cue ${blockPosition + 1} буруу форматтай байна.`);
    }

    return {
      index,
      start: match[1],
      end: match[2],
      text,
    };
  });

  return cues;
}

export function serializeSrt(cues: SubtitleCue[]): string {
  return `${cues
    .map(
      ({ index, start, end, text }) =>
        `${index}\r\n${start} --> ${end}\r\n${text.replace(/\r\n?|\n/g, "\r\n")}`,
    )
    .join("\r\n\r\n")}\r\n`;
}
