/** Model-facing text. The wake notice and the orientation are fixed so the provider prefix cache stays warm. */
/**
 * The one wake notice. No ids, timestamps or counts: every wake — single,
 * merged or replayed — injects these exact bytes, and one `raft message check`
 * drains everything pending, so a merged notice covers all coalesced wakes.
 */
export const WAKE_NOTICE = '[Raft wake] New Raft activity is waiting. Run `raft message check` now to read it, then handle it as your Raft instructions describe.';
/** Mentions a notice lists by name; the rest are counted. */
export const MENTION_NOTICE_LIST = 5;
/**
 * The mention notice: names where the agent was mentioned (target and short
 * id, never content) for mentions Raft's inbox may not deliver. Unlike the
 * wake notice it varies, but it is only injected when a sweep finds a mention
 * that no check returned.
 * @param mentions - at least one mention, oldest first.
 * @param handle - the agent's handle, for the search hint when some are only counted.
 */
export function mentionNotice(mentions, handle) {
    const head = '[Raft mention] You were mentioned and it may not appear in raft message check';
    const tail = 'if it still needs an answer.';
    if (mentions.length === 1) {
        const { target, shortId } = mentions[0];
        return `${head}: ${target} message ${shortId}. Read it with \`raft message read --target "${target}" --around ${shortId}\` and answer in that target ${tail}`;
    }
    const listed = mentions.slice(0, MENTION_NOTICE_LIST).map(({ target, shortId }) => `${target} message ${shortId}`).join('; ');
    const rest = mentions.length - MENTION_NOTICE_LIST;
    const more = rest > 0 ? `; +${rest} more (find them with \`raft message search --query "@${handle}" --sort recent\`)` : '';
    return `${head}: ${listed}${more}. Read each with \`raft message read --target "<target>" --around <shortid>\` and answer in its target ${tail}`;
}
/** Name of the agent-scoped system-prompt section carrying the orientation. */
export const ORIENTATION_SECTION = 'raft:orientation';
/**
 * Orientation for the agent's system prompt. Byte-stable across turns and
 * sessions; the profile slug is the only variable.
 * @param profile - the Raft profile slug the agent acts as.
 */
export function orientationText(profile) {
    return `<raft>
You are connected to Raft, a shared workspace for humans and agents, as the external agent behind Raft profile ${profile}; your shell already acts as that identity. Raft is where people talk to you; the terminal is for local work.
On each "[Raft wake]" notice (it carries no content):
1. Run \`raft message check\`. It prints each new message with its target and full text. Raft releases pending messages in batches, so after handling a batch run it again, until it prints exactly "No new inbox messages". If the first check already prints that, the wake was handled earlier: end the turn without running anything else.
2. Before replying in a target, run \`raft message read --target <target>\`. Raft accepts a reply only from an agent that has read the conversation up to its latest message, and Raft can deliver a message more than once: if the read shows you already replied after a message, do not answer it again.
3. Do what each new message asks, then answer it with \`raft message send --target <its target>\`, body on stdin via a <<'RAFTMSG' heredoc. Plain-text replies reach nobody. Answer messages that check returned or that a "[Raft mention]" notice names; use read and \`raft message search\` for context.
4. If the send says "Held" and saves a draft, a newer message arrived first: read the target again, then either send a revised reply normally or deliver the saved draft unchanged with \`raft message send --send-draft --target <target>\` (no stdin), or drop it if the newer message makes it unnecessary.
- When a message refers to a Raft task, claim it with \`raft task claim\` before working on it; if the claim fails, leave it. Do not create tasks for requests you can simply answer.
- For CLI syntax use \`raft <command> --help\`, or \`raft manual get raft-cli-overview --intent "<goal>" --reason "<why now>"\` when you need the full guide; run \`raft profile show\` only when you need your own profile details.
- Never print, paste or relay credentials or tokens (including anything under ~/.slock); redact any you encounter.
</raft>`;
}
