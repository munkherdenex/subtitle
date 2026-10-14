import { describe, expect, it } from "vitest";
import { parseSrt, serializeSrt } from "../lib/srt";

const sampleSrt =
  "\uFEFF1\r\n00:00:01,200 --> 00:00:03,400\r\n<i>Hello there.</i>\r\n\r\n  2  \r\n00:00:04.005 --> 00:00:06.700\r\nHow are you?\r\nToday?\r\n";

describe("SRT parsing and serialization", () => {
  it("parses and serializes cues while preserving indices, timestamps, and text", () => {
    const parsed = parseSrt(sampleSrt);

    expect(parsed).toEqual([
      {
        index: "1",
        start: "00:00:01,200",
        end: "00:00:03,400",
        text: "<i>Hello there.</i>",
      },
      {
        index: "2",
        start: "00:00:04.005",
        end: "00:00:06.700",
        text: "How are you?\nToday?",
      },
    ]);

    const serialized = serializeSrt(parsed);
    expect(serialized).toContain("00:00:01,200 --> 00:00:03,400");
    expect(serialized).toContain("00:00:04.005 --> 00:00:06.700");
    expect(parseSrt(serialized)).toEqual(parsed);
    expect(serialized).toMatch(/\r\n/);
    expect(serialized).not.toMatch(/(?<!\r)\n/);
  });

  it("tolerates extra blank lines and a missing trailing newline", () => {
    expect(
      parseSrt(
        "1\n00:00:00,000 --> 00:00:01,000\n  Hi  \n\n\n  2  \n00:00:01,000 --> 00:00:02,000\nBye",
      ),
    ).toHaveLength(2);
  });

  it("rejects malformed cues with a useful error", () => {
    expect(() => parseSrt("not an srt cue")).toThrow("SRT cue 1");
  });
});
