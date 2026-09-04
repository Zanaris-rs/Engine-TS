import { toSafeName } from '#/util/JString.js';

/**
 * Names that would let an account pass itself off as staff. The website rejects
 * these at signup; the staff CLI can override them, because an account actually
 * called mod_something is not impersonating anyone if staff created it.
 */
export const RESERVED_USERNAMES = ['jagex', 'admin', 'moderator', 'owner', 'system', 'staff', 'jmod', 'pmod'];

export type UsernameCheck = { ok: true; username: string } | { ok: false; reason: string; reserved: boolean };

/**
 * Returns the name as it will be stored, which is always `toSafeName()` output,
 * because that is what the login server looks up: base37 folds case, drops
 * characters outside its alphabet and strips trailing underscores, so 'Bob',
 * 'bob' and 'bob_' are all one account. Show the caller the canonical name -
 * it is what they will have to type at the login screen.
 */
export function checkUsername(input: string): UsernameCheck {
    if (!/^[A-Za-z0-9_ ]{1,12}$/.test(input)) {
        return { ok: false, reason: 'Username must be 1-12 characters of letters, digits, spaces or underscores.', reserved: false };
    }

    const username = toSafeName(input);

    if (username === 'invalid_name') {
        return { ok: false, reason: 'Username does not encode to a usable name.', reserved: false };
    }

    if (username.startsWith('mod_') || RESERVED_USERNAMES.includes(username)) {
        return { ok: false, reason: `'${username}' is reserved for staff.`, reserved: true };
    }

    return { ok: true, username };
}

export function checkPassword(password: string): { ok: true } | { ok: false; reason: string } {
    if (password.length < 8 || password.length > 20) {
        return { ok: false, reason: 'Password must be 8-20 characters.' };
    }

    return { ok: true };
}

export function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim());
}

/**
 * Lowercase, drop a +tag, and drop dots in gmail local parts, so that
 * `find-alts` clusters the obvious variations of one mailbox. The address is
 * never verified - this is forensic, not identity.
 */
export function normalizeEmail(email: string): string {
    const trimmed = email.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');

    if (at <= 0) {
        return trimmed;
    }

    let local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);

    const plus = local.indexOf('+');
    if (plus !== -1) {
        local = local.slice(0, plus);
    }

    if (domain === 'gmail.com' || domain === 'googlemail.com') {
        local = local.replaceAll('.', '');
    }

    return `${local}@${domain}`;
}

/**
 * The /24 (v4) or /64 (v6) a signup came from. A /24-only rule is free to
 * sidestep over IPv6, where one residential customer usually holds a whole /64.
 */
export function ipGroup(ip: string): string {
    const address = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
        return address.split('.').slice(0, 3).join('.') + '.0/24';
    }

    const groups = expandIpv6(address);
    if (groups) {
        return groups.slice(0, 4).join(':') + '::/64';
    }

    return address;
}

function expandIpv6(address: string): string[] | null {
    if (!address.includes(':')) {
        return null;
    }

    const halves = address.split('::');
    if (halves.length > 2) {
        return null;
    }

    const head = halves[0].length > 0 ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1].length > 0 ? halves[1].split(':') : [];

    if (halves.length === 1) {
        return head.length === 8 ? head.map(part => part.padStart(4, '0')) : null;
    }

    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
        return null;
    }

    return [...head, ...new Array(missing).fill('0'), ...tail].map(part => part.padStart(4, '0'));
}
