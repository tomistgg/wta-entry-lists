import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WTARG_STORAGE_LIMIT, WTARG_RECOVERY_RESERVE, wtargStorage, requireWtargStorage } from "./wtarg-storage.mjs";

function database(size, success = true) {
    const statements = [];
    return { statements, prepare(sql) { statements.push(sql); return { async run() {
        return { success, meta: size === undefined ? {} : { size_after: size } };
    } }; } };
}

test("storage checks use the whole physical database and leave the recovery reserve untouched", async () => {
    const db = database(200000000);
    const state = await wtargStorage(db, {});
    assert.equal(state.databaseBytes, 200000000);
    assert.equal(state.limitBytes, DEFAULT_WTARG_STORAGE_LIMIT);
    assert.equal(state.availableBytes, DEFAULT_WTARG_STORAGE_LIMIT - 200000000 - WTARG_RECOVERY_RESERVE);
    await requireWtargStorage(db, {}, state.availableBytes);
    await assert.rejects(requireWtargStorage(db, {}, state.availableBytes + 1), { status: 507 });
    assert.ok(db.statements.every(sql => sql === "SELECT 1 AS storage_probe"));
    await assert.rejects(requireWtargStorage(database(DEFAULT_WTARG_STORAGE_LIMIT - WTARG_RECOVERY_RESERVE), {}, 0), { status: 507 });
});

test("missing or invalid database measurements and unsafe ceilings stop collection", async () => {
    for (const value of [undefined, 0, -1, 123.5, "200000000", Infinity]) {
        await assert.rejects(wtargStorage(database(value), {}), { status: 503 });
    }
    await assert.rejects(wtargStorage(database(1000, false), {}), { status: 503 });
    for (const value of ["not-a-number", "450000001", "999999", "0"]) {
        await assert.rejects(wtargStorage(database(1000), { WTARG_STORAGE_LIMIT_BYTES: value }), { status: 503 });
    }
    const configured = await wtargStorage(database(1000), { WTARG_STORAGE_LIMIT_BYTES: "250000000" });
    assert.equal(configured.limitBytes, 250000000);
    await assert.rejects(requireWtargStorage(database(1000), {}, -1), { status: 400 });
});
