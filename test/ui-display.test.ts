import { describe, expect, it } from "vitest";
import { formatClock } from "../src/ui/live.js";

/**
 * The display layer's arithmetic, tested where it is cheap to test.
 *
 * None of this needs a DOM: the pure functions turn state into numbers or
 * strings, and the view modules only paste those results into an element. That
 * split is deliberate — display bugs of this kind are invisible in a screenshot
 * and obvious in an assertion.
 */

describe("the recording clock", () => {
  it("counts in m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(60)).toBe("1:00");
    expect(formatClock(-3)).toBe("0:00");
  });
});
