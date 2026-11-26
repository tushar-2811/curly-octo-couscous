import type { Logger } from '@aiw/logger';
import type { Evidence } from './answer';
import { issueEvidenceText, JIRA_KEY, JiraError, type JiraIssue, type JiraReader } from './jira';

const MAX_TICKETS = 4;
const KEY_IN_TEXT = /\b[A-Z][A-Z0-9_]{0,19}-\d{1,9}\b/g;

export interface JiraEvidence {
  items: Evidence[];
  /** Facts for the reply model, e.g. that a ticket was not found. */
  notes: string[];
  /** Jira is configured and answered. */
  available: boolean;
}

/** Words that say nothing about which ticket is meant. */
const STOP = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in
  into is it its just me my of on or our please should so tell than that the their them then
  there these this those to us was we were what when where whether which who whom whose why
  will with would you your yours any anyone some someone know let lets give get got tickets
  ticket jira issue issues status update updates progress latest current currently going happening
  remind check look see find there's what's who's it's is there are there one`.split(/\s+/),
);

/**
 * Keywords for a Jira text search, most specific first. Jira requires every word to match,
 * so question words and filler are dropped and the list is kept short.
 */
export function searchKeywords(text: string, ignore: string[] = []): string[] {
  const skip = new Set([...STOP, ...ignore.map((w) => w.toLowerCase())]);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !skip.has(w));
  return [...new Set(words)].slice(0, 6);
}

function toEvidence(issue: JiraIssue): Evidence {
  return {
    id: issue.key,
    source: 'jira',
    kind: issue.key,
    content: issueEvidenceText(issue),
    occurred_at: issue.updated ? new Date(issue.updated) : null,
    label: `${issue.key}: ${issue.summary}`,
    url: issue.url,
  };
}

/**
 * Tickets a reply may need: the keys in the message (found by code and by the classifier),
 * or, when Jira is needed but no key was given, a short text search. Never throws: a Jira
 * failure becomes a note so the reply can say it could not check.
 */
export async function jiraEvidence(
  jira: JiraReader | null,
  input: {
    needed: boolean;
    keys: string[];
    text: string;
    summary: string | null;
    /** Words to leave out of a search, such as the employee's name. */
    ignore?: string[];
    /** Earlier messages in the conversation, newest first: "this ticket" means one of these. */
    context?: string[];
    logger: Logger;
  },
): Promise<JiraEvidence> {
  const named = [
    ...new Set([...(input.text.toUpperCase().match(KEY_IN_TEXT) ?? []), ...input.keys]),
  ].filter((k) => JIRA_KEY.test(k));
  // No key in the message: the most recent ticket mentioned earlier in the conversation.
  let fromContext: string[] = [];
  if (named.length === 0) {
    for (const line of input.context ?? []) {
      const found = [...new Set(line.toUpperCase().match(KEY_IN_TEXT) ?? [])].filter((k) =>
        JIRA_KEY.test(k),
      );
      if (found.length > 0) {
        fromContext = found.slice(0, 2);
        break;
      }
    }
  }
  const keys = named.length > 0 ? named : fromContext;
  if (!jira) {
    return { items: [], notes: [], available: false };
  }
  if (keys.length === 0 && !input.needed) return { items: [], notes: [], available: true };
  if (fromContext.length > 0 && !input.needed) return { items: [], notes: [], available: true };

  const started = performance.now();
  const notes: string[] = [];
  if (fromContext.length > 0) {
    notes.push(
      `The message names no ticket; ${fromContext.join(' and ')} ${
        fromContext.length === 1 ? 'was' : 'were'
      } mentioned just before in the conversation, so it most likely means ${
        fromContext.length === 1 ? 'that one' : 'one of those'
      }.`,
    );
  }
  try {
    let issues: JiraIssue[];
    if (keys.length > 0) {
      const readable = keys.filter((k) => jira.allows(k)).slice(0, MAX_TICKETS);
      for (const k of keys.filter((k) => !jira.allows(k))) {
        notes.push(`${k} is in a Jira project you are not allowed to read.`);
      }
      const found = await Promise.all(readable.map((k) => jira.getIssue(k)));
      issues = found.filter((i): i is JiraIssue => i !== null);
      readable.forEach((k, i) => {
        if (!found[i]) notes.push(`${k} was not found in Jira, or you cannot see it.`);
      });
    } else {
      // Every word must match, so try all keywords, then the three longest.
      const words = searchKeywords(input.text, input.ignore);
      const longest = [...words].sort((a, b) => b.length - a.length).slice(0, 3);
      issues = words.length > 0 ? await jira.searchText(words.join(' '), 3) : [];
      if (issues.length === 0 && longest.length > 0 && longest.length < words.length) {
        issues = await jira.searchText(longest.join(' '), 3);
      }
      if (issues.length === 0) notes.push('A Jira search found no matching tickets.');
      else
        notes.push(
          'No ticket key was given; these tickets came from a Jira text search and may not be the one meant.',
        );
    }
    input.logger.info(
      {
        keys,
        from_context: fromContext.length > 0,
        fetched: issues.map((i) => i.key),
        searched: keys.length === 0 ? searchKeywords(input.text, input.ignore) : false,
        jira_ms: Math.round(performance.now() - started),
      },
      'jira looked up',
    );
    return { items: issues.map(toEvidence), notes, available: true };
  } catch (err) {
    const code = err instanceof JiraError ? err.code : 'unknown';
    input.logger.error({ err, code, keys }, 'jira lookup failed');
    return {
      items: [],
      notes: [`Jira could not be reached just now (${code}), so ticket details are unknown.`],
      available: true,
    };
  }
}
