/** Model-facing text. Both strings are fixed so the provider prefix cache stays warm. */
/**
 * The one wake notice. No ids, timestamps or counts: every wake — single,
 * merged or replayed — injects these exact bytes, and one `raft message check`
 * drains everything pending, so a merged notice covers all coalesced wakes.
 */
export declare const WAKE_NOTICE = "[Raft wake] New Raft activity is waiting. Run `raft message check` now to read it, then handle it as your Raft instructions describe.";
/** Name of the agent-scoped system-prompt section carrying the orientation. */
export declare const ORIENTATION_SECTION = "raft:orientation";
/**
 * Orientation for the agent's system prompt. Byte-stable across turns and
 * sessions; the profile slug is the only variable.
 * @param profile - the Raft profile slug the agent acts as.
 */
export declare function orientationText(profile: string): string;
