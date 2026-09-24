/**
 * One line of a player's Adventurer Log, as the world keeps it until a save
 * carries it to the login server (`Player.adventure`, `server/login/Adventure.ts`).
 *
 * `seq` counts the session's lines from 0. With the session's uuid it is the
 * line's identity, so the login server can take the same line twice - a
 * logout the world retries - and store it once.
 */
export type AdventureEvent = {
    seq: number;
    timestamp: number;
    event: string;
};

/** What a save carries: the session the lines belong to, and the lines. */
export type AdventureBatch = {
    session: string;
    events: AdventureEvent[];
};

/** Longest line kept, in characters: mysql's default VARCHAR, and the table's CHECK. */
export const ADVENTURE_EVENT_MAX = 191;

/**
 * Lines kept between two saves. Saves are at most fifteen minutes apart and
 * even a fast levelling session writes a handful in that time, so a full
 * buffer means something is looping; the lines after this are dropped rather
 * than growing a save message without bound.
 */
export const ADVENTURE_BUFFER_MAX = 200;
