import { describe, it, expect } from "vitest";
import { repairEscapeArtifacts, supportsEffort } from "./claudeClient.js";

describe("supportsEffort", () => {
  it("omits effort for models that reject it", () => {
    // Observed live: Haiku 4.5 returns 400 "This model does not support the
    // effort parameter", which fails the whole stage rather than degrading.
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("claude-sonnet-4-5")).toBe(false);
  });

  it("sends effort for models that accept it, including unknown newer ones", () => {
    expect(supportsEffort("claude-opus-5")).toBe(true);
    expect(supportsEffort("claude-sonnet-5")).toBe(true);
    expect(supportsEffort("claude-opus-6-future")).toBe(true);
  });
});

describe("repairEscapeArtifacts", () => {
  it("repairs an em-dash mangled into a control character plus literal escape text", () => {
    // Exactly what came back from a live Opus call: the model meant — but
    // emitted \r followed by the literal characters "u2014".
    const mangled = "a one-off annoyance \ru2014 three hours every Monday";
    expect(repairEscapeArtifacts(mangled)).toBe(
      "a one-off annoyance — three hours every Monday",
    );
  });

  it("handles the other whitespace escapes the same way", () => {
    expect(repairEscapeArtifacts("quote \nu201Chere\nu201D")).toBe("quote “here”");
    expect(repairEscapeArtifacts("tab \tu00e9")).toBe("tab é");
  });

  it("walks nested objects and arrays, which is where the AI output actually lives", () => {
    const input = {
      rationale: "reach \ru2014 four accounts",
      evidence: ["first \ru2013 item", "clean item"],
      nested: { note: "deep \ru2014 value" },
      score: 71.5,
      flag: true,
      nothing: null,
    };

    expect(repairEscapeArtifacts(input)).toEqual({
      rationale: "reach — four accounts",
      evidence: ["first – item", "clean item"],
      nested: { note: "deep — value" },
      score: 71.5,
      flag: true,
      nothing: null,
    });
  });

  it("leaves legitimate text alone", () => {
    const clean = "A normal sentence - with a hyphen, a newline\nand a real em-dash — here.";
    expect(repairEscapeArtifacts(clean)).toBe(clean);
  });

  it("does not touch a newline followed by ordinary prose starting with u", () => {
    // The pattern requires exactly four hex digits, so "understood" is safe.
    const text = "line one\nunderstood as prose";
    expect(repairEscapeArtifacts(text)).toBe(text);
  });
});
