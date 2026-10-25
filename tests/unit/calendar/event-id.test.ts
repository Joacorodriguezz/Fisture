import { describe, expect, it } from "vitest";
import { fistureEventId } from "../../../src/lib/calendar/event-id";

describe("fistureEventId", () => {
  it("es determinístico", async () => {
    expect(await fistureEventId("u1", "m1")).toBe(await fistureEventId("u1", "m1"));
  });

  it("usa solo el alfabeto base32hex que exige Google (a-v, 0-9) y un largo válido", async () => {
    const id = await fistureEventId("u1", "m1");
    expect(id).toMatch(/^[a-v0-9]+$/);
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });

  it("cambia con el usuario o con el partido", async () => {
    const base = await fistureEventId("u1", "m1");
    expect(await fistureEventId("u2", "m1")).not.toBe(base);
    expect(await fistureEventId("u1", "m2")).not.toBe(base);
  });

  it("no confunde ('ab','c') con ('a','bc')", async () => {
    expect(await fistureEventId("ab", "c")).not.toBe(await fistureEventId("a", "bc"));
  });
});
