import assert from "node:assert/strict";
import test from "node:test";
import { monday, rankingDates, slug } from "../entry-lists.mjs";

test("deadline weeks handle weekday, weekend, year boundary and future deadlines", () => {
    assert.equal(monday("2027-01-03"), "2026-12-28");
    assert.equal(rankingDates("2026-11-09", "2026-11-05").main, "2026-10-12");
    assert.equal(rankingDates("2026-11-07", "2026-11-05").main, "2026-10-12");
    assert.equal(rankingDates("2026-12-28", "2026-11-05").main, "2026-11-02");
    assert.equal(slug("La Bisbal D'Empordá #2"), "la-bisbal-d-emporda-2");
});
