import type { ColumnType } from 'kysely';
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type account = {
    id: Generated<number>;
    username: string;
    password: string;
    email: string;
    email_normalized: string;
    registration_ip: string | null;
    registration_group: string | null;
    registration_date: Generated<Timestamp>;
    signup_agent_hash: string | null;
    muted_until: Timestamp | null;
    banned_until: Timestamp | null;
    playable_after: Timestamp | null;
    staffmodlevel: Generated<number>;
    members: Generated<boolean>;
    invites_enabled: Generated<boolean>;
};
export type account_login = {
    account_id: number;
    profile: string;
    logged_in: Generated<number>;
    login_time: Timestamp | null;
    logged_out: Generated<number>;
    logout_time: Timestamp | null;
};
export type account_look = {
    account_id: number;
    profile: string;
    gender: number;
    kits: string;
    colours: string;
    worn: string;
    updated_at: Generated<Timestamp>;
};
export type account_message = {
    id: Generated<number>;
    account_id: number;
    ticket_id: number | null;
    kind: string;
    subject: string;
    body: string;
    created_by_account_id: number | null;
    created_at: Generated<Timestamp>;
    read_at: Timestamp | null;
};
export type adventure_block = {
    owner_account_id: number;
    blocked_account_id: number;
    created_at: Generated<Timestamp>;
};
export type adventure_event = {
    id: Generated<number>;
    account_id: number;
    profile: string;
    session_uuid: string;
    seq: number;
    occurred_at: Timestamp;
    category: number;
    event: string;
};
export type adventure_gz = {
    event_id: number;
    account_id: number;
    created_at: Generated<Timestamp>;
};
export type adventure_log_profile = {
    account_id: number;
    headline: Generated<string>;
    about: Generated<string>;
    custom_css: Generated<string>;
    css_disabled_at: Timestamp | null;
    hidden_categories: Generated<number>;
    pinned_update_id: number | null;
    updated_at: Generated<Timestamp>;
};
export type adventure_outfit = {
    account_id: number;
    slot: number;
    name: string;
    gender: number;
    kits: string;
    colours: string;
    worn: string;
    is_default: Generated<boolean>;
    updated_at: Generated<Timestamp>;
};
export type adventure_persona = {
    account_id: number;
    headline_colour: Generated<number>;
    headline_effect: Generated<number>;
    title: Generated<string>;
    examine: Generated<string>;
    hangout: Generated<string>;
    clan: Generated<string>;
    goals: Generated<string>;
    god: string | null;
    home_town: string | null;
    playstyle: string | null;
    scene: string | null;
    signature_emote: string | null;
    dialogue: Generated<string>;
    updated_at: Generated<Timestamp>;
};
export type adventure_reply = {
    id: Generated<number>;
    update_id: number;
    author_account_id: number;
    body: string;
    created_at: Generated<Timestamp>;
    deleted_at: Timestamp | null;
    staff_hidden_at: Timestamp | null;
};
export type adventure_report = {
    id: Generated<number>;
    reporter_account_id: number;
    target_kind: string;
    target_id: number;
    reason: string;
    created_at: Generated<Timestamp>;
    resolved_at: Timestamp | null;
    resolved_by_account_id: number | null;
    resolution: string | null;
    note: string | null;
};
export type adventure_update = {
    id: Generated<number>;
    account_id: number;
    body: string;
    created_at: Generated<Timestamp>;
    deleted_at: Timestamp | null;
    staff_hidden_at: Timestamp | null;
    edited_at: Timestamp | null;
};
export type economy_flow = {
    id: Generated<number>;
    taken_at: Generated<Timestamp>;
    profile: string;
    item_id: number;
    delta: number;
};
export type economy_snapshot = {
    id: Generated<number>;
    taken_at: Generated<Timestamp>;
    profile: string;
    players: number;
    coins: number;
    items: unknown;
    tracked: unknown;
};
export type friendlist = {
    account_id: number;
    friend_account_id: number;
    profile: Generated<string>;
    created: Generated<Timestamp>;
};
export type hiscore = {
    account_id: number;
    profile: Generated<string>;
    type: number;
    level: number;
    value: number;
    date: Generated<Timestamp>;
};
export type hiscore_large = {
    account_id: number;
    profile: Generated<string>;
    type: number;
    level: number;
    value: number;
    date: Generated<Timestamp>;
};
export type ignorelist = {
    account_id: number;
    value: string;
    profile: Generated<string>;
    created: Generated<Timestamp>;
};
export type input_report = {
    id: Generated<number>;
    session_uuid: string;
    timestamp: Timestamp;
    data: Buffer;
};
export type invite = {
    id: Generated<number>;
    code: string;
    created_by_account_id: number;
    created_at: Generated<Timestamp>;
    expires_at: Timestamp;
    claimed_by_account_id: number | null;
    claimed_at: Timestamp | null;
    revoked_at: Timestamp | null;
    revoked_reason: string | null;
};
export type invite_attempt = {
    id: Generated<number>;
    ip: string;
    created_at: Generated<Timestamp>;
};
export type ipban = {
    ip: string;
};
export type login_attempt = {
    id: Generated<number>;
    username: string;
    ip: string;
    created_at: Generated<Timestamp>;
};
export type private_chat = {
    id: Generated<number>;
    account_id: number;
    profile: string;
    timestamp: Timestamp;
    coord: number;
    to_account_id: number;
    message: string;
};
export type public_chat = {
    id: Generated<number>;
    session_uuid: string;
    timestamp: Timestamp;
    coord: number;
    message: string;
};
export type punishment = {
    id: Generated<number>;
    account_id: number;
    username: string;
    kind: string;
    issued_at: Generated<Timestamp>;
    until: Timestamp | null;
    automated: Generated<boolean>;
    issued_by_account_id: number | null;
    note: string | null;
    lifted_at: Timestamp | null;
    lifted_by_account_id: number | null;
};
export type record_attempt = {
    id: Generated<number>;
    account_id: number;
    profile: string;
    duration_seconds: number;
    state: Generated<string>;
    reason: string | null;
    initial_logout_at: Timestamp;
    started_at: Generated<Timestamp>;
    final_logout_at: Timestamp | null;
    stopped_at: Timestamp | null;
    elapsed_ms: number | null;
};
export type record_attempt_skill = {
    attempt_id: number;
    category: number;
    start_xp: number;
    end_xp: number | null;
    gained: number | null;
};
export type report = {
    id: Generated<number>;
    session_uuid: string;
    timestamp: Timestamp;
    coord: number;
    offender: string;
    reason: number;
    reporter_account_id: number | null;
    world: number | null;
    uuid: string | null;
    offender_account_id: number | null;
    offender_session_uuid: string | null;
    offender_coord: number | null;
    resolved_at: Timestamp | null;
    resolution: string | null;
    resolved_by_account_id: number | null;
    staff_note: string | null;
};
export type report_chat = {
    id: Generated<number>;
    report_uuid: string;
    at: Timestamp;
    kind: string;
    to_username: string | null;
    coord: number;
    message: string;
};
export type report_input = {
    id: Generated<number>;
    report_uuid: string;
    seq: number;
    kind: string;
    client: string;
    started_at: Timestamp;
    flushed_at: Timestamp;
    data: Buffer;
};
export type session = {
    uuid: string;
    account_id: number;
    profile: string;
    world: number;
    timestamp: Timestamp;
    uid: number;
    ip: string | null;
};
export type session_log = {
    id: Generated<number>;
    session_uuid: string;
    timestamp: Timestamp;
    coord: number;
    event: string;
    event_type: Generated<number>;
};
export type session_wealth = {
    id: Generated<number>;
    session_uuid: string;
    timestamp: Timestamp;
    coord: number;
    event_type: Generated<number>;
    account_items: string;
    account_value: number;
    recipient_session: string | null;
    recipient_items: string | null;
    recipient_value: number | null;
};
export type signup_attempt = {
    id: Generated<number>;
    ip: string;
    ip_group: string;
    created_at: Generated<Timestamp>;
};
export type staff_action = {
    id: Generated<number>;
    actor_account_id: number;
    action: string;
    target: string;
    created_at: Generated<Timestamp>;
};
export type staff_spawn = {
    id: Generated<number>;
    staff_account_id: number;
    target_account_id: number | null;
    item_id: number;
    count: number;
    world: number;
    created_at: Generated<Timestamp>;
};
export type ticket = {
    id: Generated<number>;
    account_id: number;
    kind: string;
    subject: string;
    status: Generated<string>;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
};
export type ticket_message = {
    id: Generated<number>;
    ticket_id: number;
    author_account_id: number;
    from_staff: Generated<boolean>;
    body: string;
    created_at: Generated<Timestamp>;
};
export type DB = {
    account: account;
    account_login: account_login;
    account_look: account_look;
    account_message: account_message;
    adventure_block: adventure_block;
    adventure_event: adventure_event;
    adventure_gz: adventure_gz;
    adventure_log_profile: adventure_log_profile;
    adventure_outfit: adventure_outfit;
    adventure_persona: adventure_persona;
    adventure_reply: adventure_reply;
    adventure_report: adventure_report;
    adventure_update: adventure_update;
    economy_flow: economy_flow;
    economy_snapshot: economy_snapshot;
    friendlist: friendlist;
    hiscore: hiscore;
    hiscore_large: hiscore_large;
    ignorelist: ignorelist;
    input_report: input_report;
    invite: invite;
    invite_attempt: invite_attempt;
    ipban: ipban;
    login_attempt: login_attempt;
    private_chat: private_chat;
    public_chat: public_chat;
    punishment: punishment;
    record_attempt: record_attempt;
    record_attempt_skill: record_attempt_skill;
    report: report;
    report_chat: report_chat;
    report_input: report_input;
    session: session;
    session_log: session_log;
    session_wealth: session_wealth;
    signup_attempt: signup_attempt;
    staff_action: staff_action;
    staff_spawn: staff_spawn;
    ticket: ticket;
    ticket_message: ticket_message;
};
