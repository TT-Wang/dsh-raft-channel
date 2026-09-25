/** The per-profile pointer to the current session, written atomically. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STATE_SCHEMA = 'dsh-raft-channel-state.v1'

export interface ChannelState {
  schema: typeof STATE_SCHEMA
  profile: string
  sessionPrefix: string
  /** `n` of the current session `<sessionPrefix>-<n>`. */
  index: number
  sessionId: string
  /** The session this one replaced by rotation, when any; it stays resumable. */
  previousSessionId?: string
  updatedAt: string
}

/**
 * Read the state file.
 * @returns the state, or undefined when the file is absent. A malformed file throws.
 */
export async function readState(file: string): Promise<ChannelState | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(text) as Partial<ChannelState>
  if (value.schema !== STATE_SCHEMA || typeof value.sessionId !== 'string' || typeof value.sessionPrefix !== 'string'
    || typeof value.profile !== 'string' || !Number.isSafeInteger(value.index) || (value.index ?? 0) < 1) {
    throw new Error(`raft-channel state file ${file} is not a ${STATE_SCHEMA} record`)
  }
  return value as ChannelState
}

/** Write the state file via a same-directory temp file and rename (atomic on POSIX and NTFS). */
export async function writeState(file: string, state: ChannelState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
