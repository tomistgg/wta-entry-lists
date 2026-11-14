export const DEFAULT_WTARG_STORAGE_LIMIT = 400000000;
export const MAX_WTARG_STORAGE_LIMIT = 450000000;
export const WTARG_RECOVERY_RESERVE = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const failure = (message, status = 507) => Object.assign(new Error(message), { status });

export const payloadBytes = value => encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;

// Payloads also occupy SQLite record, page and primary-index space.
export const storageCharge = (bytes, rows = 1) => Math.ceil(bytes * 1.25) + rows * 8192;

export async function wtargStorage(db, env) {
    const limitBytes = Number(env.WTARG_STORAGE_LIMIT_BYTES || DEFAULT_WTARG_STORAGE_LIMIT);
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1000000 || limitBytes > MAX_WTARG_STORAGE_LIMIT) {
        throw failure("The collector storage ceiling is not configured safely.", 503);
    }
    const result = await db.prepare("SELECT 1 AS storage_probe").run();
    const databaseBytes = result.meta?.size_after;
    if (result.success !== true || !Number.isSafeInteger(databaseBytes) || databaseBytes < 1) {
        throw failure("The database size could not be verified; collection remains stopped.", 503);
    }
    return { databaseBytes, limitBytes, recoveryReserveBytes: WTARG_RECOVERY_RESERVE,
        availableBytes: Math.max(0, limitBytes - databaseBytes - WTARG_RECOVERY_RESERVE) };
}

export async function requireWtargStorage(db, env, growth = 0) {
    if (!Number.isSafeInteger(growth) || growth < 0) throw failure("Invalid collector storage projection.", 400);
    const state = await wtargStorage(db, env);
    if (growth > state.availableBytes || state.databaseBytes + WTARG_RECOVERY_RESERVE >= state.limitBytes) {
        throw failure("The free storage reserve would be exceeded. Saved data was kept; review collection storage before retrying.");
    }
    return { ...state, projectedGrowthBytes: growth,
        projectedBytes: state.databaseBytes + growth + WTARG_RECOVERY_RESERVE };
}
