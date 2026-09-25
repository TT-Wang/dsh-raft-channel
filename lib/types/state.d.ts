export declare const STATE_SCHEMA = "dsh-raft-channel-state.v1";
export interface ChannelState {
    schema: typeof STATE_SCHEMA;
    profile: string;
    sessionPrefix: string;
    /** `n` of the current session `<sessionPrefix>-<n>`. */
    index: number;
    sessionId: string;
    /** The session this one replaced by rotation, when any; it stays resumable. */
    previousSessionId?: string;
    updatedAt: string;
}
/**
 * Read the state file.
 * @returns the state, or undefined when the file is absent. A malformed file throws.
 */
export declare function readState(file: string): Promise<ChannelState | undefined>;
/** Write the state file via a same-directory temp file and rename (atomic on POSIX and NTFS). */
export declare function writeState(file: string, state: ChannelState): Promise<void>;
