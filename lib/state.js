/** The per-profile pointer to the current session, written atomically. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export const STATE_SCHEMA = 'dsh-raft-channel-state.v1';
/**
 * Read the state file.
 * @returns the state, or undefined when the file is absent. A malformed file throws.
 */
export async function readState(file) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const value = JSON.parse(text);
    if (value.schema !== STATE_SCHEMA || typeof value.sessionId !== 'string' || typeof value.sessionPrefix !== 'string'
        || typeof value.profile !== 'string' || !Number.isSafeInteger(value.index) || (value.index ?? 0) < 1) {
        throw new Error(`raft-channel state file ${file} is not a ${STATE_SCHEMA} record`);
    }
    return value;
}
/** Write the state file via a same-directory temp file and rename (atomic on POSIX and NTFS). */
export async function writeState(file, state) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
    }
}
