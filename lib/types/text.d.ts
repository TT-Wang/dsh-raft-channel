/** Model-facing text. The wake notice and the orientation are fixed so the provider prefix cache stays warm. */
/**
 * The one wake notice. No ids, timestamps or counts: every wake — single,
 * merged or replayed — injects these exact bytes, and one `raft message check`
 * drains everything pending, so a merged notice covers all coalesced wakes.
 */
export declare const WAKE_NOTICE = "[Raft wake] New Raft activity is waiting. Run `raft message check` now to read it, then handle it as your Raft instructions describe.";
/** One mention a sweep found: where to read it and the 8-character short id. */
export interface MentionRef {
    target: string;
    shortId: string;
}
/** Mentions a notice lists by name; the rest are counted. */
export declare const MENTION_NOTICE_LIST = 5;
/**
 * The mention notice: names where the agent was mentioned (target and short
 * id, never content) for mentions Raft's inbox may not deliver. Unlike the
 * wake notice it varies, but it is only injected when a sweep finds a mention
 * that no check returned.
 * @param mentions - at least one mention, oldest first.
 * @param handle - the agent's handle, for the search hint when some are only counted.
 */
export declare function mentionNotice(mentions: readonly MentionRef[], handle: string): string;
/** Name of the agent-scoped system-prompt section carrying the orientation. */
export declare const ORIENTATION_SECTION = "raft:orientation";
/**
 * Orientation for the agent's system prompt. Byte-stable across turns and
 * sessions; the profile slug is the only variable.
 * @param profile - the Raft profile slug the agent acts as.
 */
export declare function orientationText(profile: string): string;
