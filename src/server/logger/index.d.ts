/**
 * What the world posts to the logger thread about a report, and what the
 * logger server reads off the socket.
 *
 * The point of these two messages is that the world generates the `report_uuid`
 * and carries everything the logger needs with it. The login server writes the
 * `report` row under the same uuid, and the two hub processes never speak: the
 * evidence can land before the report row exists, or long after, and neither
 * has to wait for the other.
 */

/**
 * A capture has started.
 *
 * Sent unconditionally the moment the world opens one, ahead of any chunk and
 * even when there will be no chunks at all - an offender who logged in a minute
 * ago has an empty ring, and a Java client sends one move record per packet. It
 * is what the before-window chat copy hangs off, so evidence does not depend on
 * the offender having moved their mouse.
 */
export interface EvidenceBeginMessage {
    type: 'evidence_begin';
    report_uuid: string;
    report_at: number;
    offender_account_id: number | null;
}

/**
 * One finished chunk of a player's input.
 *
 * `kind` is the sort of evidence - only input travels this way today - and
 * `capture` is which half of the window it belongs to: `ring` for a chunk the
 * player's ring was already holding when the report landed (the minutes before
 * it), `live` for one recorded after. `capture` is what `report_input.kind`
 * stores.
 *
 * `report_at` and `offender_account_id` ride along because every message about
 * a report has to stand on its own - the logger never asks the login server
 * anything. `seq` orders the chunks of one report; `data` is base64 of the
 * engine's own record framing, decoded by the website and by nothing else.
 */
export interface ReportEvidenceMessage {
    type: 'report_evidence';
    kind: 'input';
    capture: 'ring' | 'live';
    report_uuid: string;
    report_at: number;
    offender_account_id: number | null;
    seq: number;
    started_at: number;
    flushed_at: number;
    client: 'web' | 'java';
    data: string;
}

/**
 * The capture window has closed. This is what tells the logger server to copy
 * the after-window chat, so it is sent even for a report that never got a live
 * tail - there is no input to end, but there is still chat worth keeping.
 */
export interface EvidenceEndMessage {
    type: 'evidence_end';
    report_uuid: string;
    report_at: number;
    offender_account_id: number | null;
    ended_at: number;
}

export type EvidenceMessage = EvidenceBeginMessage | ReportEvidenceMessage | EvidenceEndMessage;
