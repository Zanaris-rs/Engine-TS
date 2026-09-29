import World from '#/engine/World.js';

import Player from '#/engine/entity/Player.js';
import InputRing from '#/engine/entity/tracking/InputRing.js';

import EventAppletFocus from '#/network/game/client/model/EventAppletFocus.js';
import EventCameraPosition from '#/network/game/client/model/EventCameraPosition.js';
import EventMouseClick from '#/network/game/client/model/EventMouseClick.js';
import EventMouseMove from '#/network/game/client/model/EventMouseMove.js';

/**
 * A player's mouse and focus stream, on its way to `report_input`.
 *
 * This used to be a 5 KB buffer that only filled while `active` was set, and
 * `active` was only ever set by a macro report - so the evidence began after
 * the report and the minutes that caused it were never recorded. Recording is
 * always on now: every packet goes into an {@link InputRing}, which keeps the
 * last sixteen chunks (roughly ten minutes) and throws the rest away.
 *
 * A report drains that ring into the database and starts a live tail; nothing
 * else ever leaves this process. `World` owns the report identity and the
 * transport, so all this class does is hand the ring the tick and the clock,
 * and route finished chunks.
 */
/**
 * What a capture is filed under. The first three travel with every chunk,
 * because the logger server writes the rows and copies the chat window without
 * ever asking the login server anything - the two hub processes need no
 * ordering between them, which is the whole point of the world generating the
 * uuid.
 *
 * `nextSeq` is the fourth because a capture outlives the player object it
 * started on. An offender who logs out and back in inside their own window
 * gets a brand new {@link InputRing} whose own `seq` counts from 0 again, and
 * two chunks filed as `seq 0` under one uuid are one chunk as far as the
 * logger's dedupe and the website's decoder are concerned. So the number that
 * orders a report's chunks is counted per *capture*, on this object - which
 * `World` holds in `inputCaptures` and hands back to the new ring on the way
 * in - and never by the ring.
 */
export type InputCapture = {
    uuid: string;
    reportAt: number;
    accountId: number | null;
    nextSeq: number;
};

export default class InputTracking {
    private readonly player: Player;
    private readonly ring: InputRing;

    /**
     * The report this player's evidence belongs to, set when the tail starts.
     * A chunk cannot be filed without one, which is why a chunk sealed while
     * nobody has reported the player is never submitted anywhere.
     */
    capture: InputCapture | null = null;

    constructor(player: Player) {
        this.player = player;
        this.ring = new InputRing(chunk => World.submitInputTracking(this.player, chunk, 'live'));
    }

    /** Is a live tail running? */
    isTracked(): boolean {
        return this.ring.isTracked(Date.now());
    }

    /** When the live tail ends, as epoch ms; 0 when nothing is being tracked. */
    get activeUntil(): number {
        return this.ring.activeUntil;
    }

    onCycle(): void {
        this.ring.onCycle(Date.now());
    }

    /**
     * Start (or extend) a capture. Everything the ring is holding is submitted
     * first, oldest chunk first, so the evidence starts before the report and
     * not after it; the tail that follows arrives chunk by chunk as it rotates.
     */
    track(untilMs: number, capture: InputCapture): void {
        const now = Date.now();

        this.capture = capture;
        this.ring.track(untilMs, World.currentTick, now);

        for (const chunk of this.ring.drainRing()) {
            World.submitInputTracking(this.player, chunk, 'ring');
        }
    }

    /**
     * A second report on somebody already being watched: push the end of the
     * window back rather than opening a second capture over the same minutes.
     */
    extend(untilMs: number): void {
        this.ring.extend(untilMs);
    }

    /**
     * Submit what the ring holds and nothing more: the world is already running
     * as many live tails as it will, so this report gets the minutes before it
     * and no tail of its own.
     */
    dumpRing(capture: InputCapture): void {
        const now = Date.now();

        this.capture = capture;
        this.ring.flush(now);

        for (const chunk of this.ring.drainRing()) {
            World.submitInputTracking(this.player, chunk, 'ring');
        }
    }

    /** Stop early. What the tail had collected is still submitted. */
    untrack(): void {
        this.ring.untrack(Date.now());
    }

    /**
     * Logging out. Anything captured under a live tail is worth keeping;
     * anything the ring is holding is not - the player was not reported, and
     * their idle mouse is nobody's business.
     *
     * The last partial chunk of a running tail is sealed and submitted, and
     * that is the only thing this posts. No `evidence_end`: the capture is
     * `World.inputCaptures`' business and it outlives this object deliberately,
     * so an offender who logs out to shake off a moderator comes back into the
     * window they left - see `World.resumeInputCapture`. The window closes when
     * its clock says so, or when the world goes down, and never because
     * somebody pulled their plug.
     */
    cleanup(): void {
        this.ring.untrack(Date.now());
        this.ring.clear();
        this.capture = null;
    }

    cameraPosition(event: EventCameraPosition) {
        this.ring.cameraPosition(World.currentTick, Date.now(), event.pitch, event.yaw);
    }

    appletFocus(event: EventAppletFocus) {
        this.ring.appletFocus(World.currentTick, Date.now(), event.focus);
    }

    mouseClick(event: EventMouseClick) {
        this.ring.mouseClick(World.currentTick, Date.now(), event.info);
    }

    /**
     * The old cap was 160 bytes, which threw away perfectly ordinary packets:
     * the TS client sends up to 243 and the record's length field is a `p1`,
     * so 255 is the real limit. The ring counts the two-byte header itself and
     * leaves marker 1 behind when it does have to drop one.
     */
    mouseMove(event: EventMouseMove) {
        this.ring.mouseMove(World.currentTick, Date.now(), event.data);
    }
}
