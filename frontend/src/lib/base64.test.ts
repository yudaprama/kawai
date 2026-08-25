import { describe, expect, it } from "vitest";
import { base64ToBytes, base64ToText, bytesToBase64, dataUrlToFile } from "@/lib/base64";

describe("base64 roundtrips", () => {
  it("round-trips ASCII bytes", () => {
    const bytes = new TextEncoder().encode("hello kawai");
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("round-trips multi-chunk buffers (>0x8000 boundary)", () => {
    const bytes = new Uint8Array(0x8000 + 17).map((_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("decodes UTF-8 text", () => {
    // "héllo →" in UTF-8
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("héllo →")));
    expect(base64ToText(b64)).toBe("héllo →");
  });
});

describe("dataUrlToFile", () => {
  it("extracts mime and name", () => {
    const file = dataUrlToFile(`data:image/png;base64,${btoa("abc")}`, "shot.png");
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("shot.png");
    expect(file.size).toBe(3);
  });

  it("falls back to octet-stream without a mime", () => {
    const file = dataUrlToFile("data:;base64,QQ==", "f.bin");
    expect(file.type).toBe("application/octet-stream");
    expect(file.size).toBe(1);
  });
});
