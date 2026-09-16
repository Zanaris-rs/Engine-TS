import { randomBytes } from 'node:crypto';

/**
 * Invite codes: eighty random bits as sixteen Crockford base32 characters.
 *
 * Stored ungrouped and upper-case, shown in four groups of four. The website's
 * lib/invite/code.ts is the same contract with the same test vectors, and the
 * CHECK constraint in prisma/postgres/migrations/6_invites is what both of them
 * answer to.
 */
export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

const INVITE_BYTES = 10;

export function generateInviteCode(bytes: Uint8Array = randomBytes(INVITE_BYTES)): string {
    if (bytes.length !== INVITE_BYTES) {
        throw new Error(`an invite code is ${INVITE_BYTES} random bytes, not ${bytes.length}`);
    }

    let code = '';
    let buffered = 0;
    let bits = 0;

    for (const byte of bytes) {
        buffered = (buffered << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            code += INVITE_ALPHABET[(buffered >>> (bits - 5)) & 31];
            bits -= 5;
        }

        // keep only the bits not yet written, so the buffer never outgrows 32
        buffered &= (1 << bits) - 1;
    }

    return code;
}

/** Upper-case, drop spaces and dashes, read I and L as 1 and O as 0. */
export function normalizeInviteCode(raw: string): string | null {
    const code = raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
    return INVITE_CODE_PATTERN.test(code) ? code : null;
}

export function formatInviteCode(code: string): string {
    return (code.match(/.{1,4}/g) ?? []).join('-');
}
