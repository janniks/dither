import { describe, it, expect } from "vitest";
import { main } from "./main";

describe("main command", () => {
  it("declares the expected metadata", () => {
    expect(main.meta).toMatchObject({
      name: "dither",
      version: "0.0.1",
    });
  });
});
