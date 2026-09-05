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
};
export type account_login = {
    account_id: number;
    profile: string;
    logged_in: Generated<number>;
    login_time: Timestamp | null;
    logged_out: Generated<number>;
    logout_time: Timestamp | null;
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
export type report = {
    id: Generated<number>;
    session_uuid: string;
    timestamp: Timestamp;
    coord: number;
    offender: string;
    reason: number;
    reporter_account_id: number | null;
    world: number | null;
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
    account_message: account_message;
    friendlist: friendlist;
    hiscore: hiscore;
    hiscore_large: hiscore_large;
    ignorelist: ignorelist;
    input_report: input_report;
    ipban: ipban;
    login_attempt: login_attempt;
    private_chat: private_chat;
    public_chat: public_chat;
    report: report;
    session: session;
    session_log: session_log;
    session_wealth: session_wealth;
    signup_attempt: signup_attempt;
    staff_action: staff_action;
    ticket: ticket;
    ticket_message: ticket_message;
};
