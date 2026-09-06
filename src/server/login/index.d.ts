interface LoginResponse {
    type: string;
    username: string;
    socket: string;
    reply: number;
    lowMemory: boolean;
    reconnecting: boolean;
    staffmodlevel?: number;
    muted_until?: any | null;
    save: Uint8Array | null;
    account_id: number;
    members: boolean;
    messageCount?: number;
    remaining?: number;
}

interface LogoutResponse {
    type: string;
    username: string;
    success: boolean;
}

/**
 * A Report Abuse on its way from the world to the login server, which owns the
 * `report` table.
 *
 * `account_id`, `session_uuid` and `coord` are the *reporter's* - they always
 * have been. What is new is the offender: `uuid` is the evidence key the world
 * generated, the same one the logger server writes on every `report_input` and
 * `report_chat` row, and the three `offender_*` fields are filled in only when
 * the offender was on the reporting world at the time. They are null otherwise,
 * including for a cross-world report, and the login server resolves the account
 * from the username itself.
 *
 * `uuid` is null when no evidence was captured: any reason but macroing or bug
 * abuse, or an offender who was not online to capture.
 */
export interface PlayerReportRequest {
    type: 'player_report';
    account_id: number;
    session_uuid: string;
    coord: number;
    offender: string;
    reason: number;
    uuid: string | null;
    offender_account_id: number | null;
    offender_session_uuid: string | null;
    offender_coord: number | null;
}

/**
 * An item a staff member conjured, on its way from the world to the login
 * server, which owns the `staff_spawn` table.
 *
 * Every cheat in `ClientCheatHandler` that adds an item to an inventory sends
 * one - `::give`, `::giveother`, `::givecrap` and `::givemany` - and only on a
 * production world, where the spawn is a fact about the live economy rather
 * than a developer's afternoon. `::givecrap` sends 28, one per item, because
 * that is 28 different items entering the game.
 *
 * `target_account_id` is the recipient: the staff member themselves for
 * everything but `::giveother`, and null only when the recipient has no
 * account behind them, which cannot happen on a world with the login server
 * enabled. `world` is the world's own id, so a row is attributable without
 * reading the connection it arrived on.
 */
export interface PlayerSpawnRequest {
    type: 'player_spawn';
    staff_account_id: number;
    target_account_id: number | null;
    item_id: number;
    count: number;
    world: number;
}

export type GenericLoginThreadResponse = LoginResponse | LogoutResponse;

export function isPlayerLoginResponse(response: LoginResponse | LogoutResponse): response is LoginResponse {
    return response.type === 'player_login';
}

export function isPlayerLogoutResponse(response: LoginResponse | LogoutResponse): response is LogoutResponse {
    return response.type === 'player_logout';
}
