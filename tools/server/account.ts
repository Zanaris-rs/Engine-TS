/**
 * Staff account tools, run against whatever backend data/config/world.json
 * selects:
 *
 *   npm run account -- create-staff <name> <email> <password> [level] [--force]
 *   npm run account -- reset-password <name> <newpassword>
 *   npm run account -- ban-ip <ip>
 *   npm run account -- find-alts <email|ip|ip-group>
 *
 * With account.autoCreate off there is no other way to make the first account,
 * and with no mailer there is no other way to recover a lost password.
 */
import * as bcrypt from 'bcrypt-ts';

import { db, toDbDate } from '#/db/query.js';
import { checkPassword, checkUsername, ipGroup, isValidEmail, normalizeEmail } from '#/util/Account.js';
import Environment from '#/util/Environment.js';
import { toDisplayName } from '#/util/JString.js';

const USAGE = `Usage:
  account.ts create-staff <name> <email> <password> [level] [--force]
  account.ts reset-password <name> <newpassword>
  account.ts ban-ip <ip>
  account.ts find-alts <email|ip|ip-group>`;

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function resolveUsername(input: string, force: boolean): string {
    const check = checkUsername(input);

    if (!check.ok) {
        if (!(check.reserved && force)) {
            fail(check.reserved ? `${check.reason} Pass --force if that is deliberate.` : check.reason);
        }

        return input.toLowerCase().replaceAll(' ', '_');
    }

    return check.username;
}

async function createStaff(args: string[]) {
    const force = args.includes('--force');
    const [name, email, password, level = '2'] = args.filter(arg => arg !== '--force');

    if (!name || !email || !password) {
        fail(USAGE);
    }

    const username = resolveUsername(name, force);

    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
        fail(passwordCheck.reason);
    }

    if (!isValidEmail(email)) {
        fail(`'${email}' does not look like an email address.`);
    }

    const staffmodlevel = Number(level);
    if (!Number.isInteger(staffmodlevel) || staffmodlevel < 0 || staffmodlevel > 4) {
        fail('Staff mod level must be an integer from 0 to 4.');
    }

    const existing = await db.selectFrom('account').select('id').where('username', '=', username).executeTakeFirst();
    if (existing) {
        fail(`'${username}' already exists (id ${existing.id}). Use reset-password to change its password.`);
    }

    await db
        .insertInto('account')
        .values({
            username,
            password: bcrypt.hashSync(password.toLowerCase(), 10),
            email,
            email_normalized: normalizeEmail(email),
            registration_date: toDbDate(new Date()),
            staffmodlevel,
            members: true
        })
        .execute();

    const account = await db.selectFrom('account').select(['id', 'username', 'staffmodlevel']).where('username', '=', username).executeTakeFirstOrThrow();

    console.log(`Created ${toDisplayName(account.username)} (id ${account.id}, username '${account.username}', staffmodlevel ${account.staffmodlevel}).`);
    console.log('Note that passwords are case-insensitive: the login server lowercases them before hashing.');
}

async function resetPassword(args: string[]) {
    const [name, password] = args;

    if (!name || !password) {
        fail(USAGE);
    }

    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
        fail(passwordCheck.reason);
    }

    const username = resolveUsername(name, true);

    const account = await db.selectFrom('account').select(['id', 'username']).where('username', '=', username).executeTakeFirst();
    if (!account) {
        fail(`No account called '${username}'.`);
    }

    await db
        .updateTable('account')
        .set({ password: bcrypt.hashSync(password.toLowerCase(), 10) })
        .where('id', '=', account.id)
        .execute();

    console.log(`Reset the password for ${toDisplayName(account.username)} (id ${account.id}).`);
}

async function banIp(args: string[]) {
    const [ip] = args;

    if (!ip) {
        fail(USAGE);
    }

    const existing = await db.selectFrom('ipban').select('ip').where('ip', '=', ip).executeTakeFirst();
    if (existing) {
        console.log(`${ip} is already banned.`);
        return;
    }

    await db.insertInto('ipban').values({ ip }).execute();

    const accounts = await db.selectFrom('account').select(['id', 'username']).where('registration_ip', '=', ip).execute();
    console.log(`Banned ${ip}. ${accounts.length} account(s) registered from it: ${accounts.map(a => a.username).join(', ') || 'none'}.`);
}

async function findAlts(args: string[]) {
    const [needle] = args;

    if (!needle) {
        fail(USAGE);
    }

    let query = db.selectFrom('account').select(['id', 'username', 'email', 'registration_ip', 'registration_group', 'registration_date', 'staffmodlevel', 'banned_until']);

    if (needle.includes('@')) {
        query = query.where('email_normalized', '=', normalizeEmail(needle));
    } else if (needle.includes('/')) {
        query = query.where('registration_group', '=', needle);
    } else {
        // an exact address matches registration_ip; it also names a group, and
        // rows written before registration_group existed only have the address
        query = query.where(eb => eb.or([eb('registration_ip', '=', needle), eb('registration_group', '=', ipGroup(needle))]));
    }

    const accounts = await query.orderBy('id').execute();

    if (accounts.length === 0) {
        console.log(`No accounts match '${needle}'.`);
        return;
    }

    console.log(`${accounts.length} account(s) matching '${needle}':`);
    for (const account of accounts) {
        const flags = [account.staffmodlevel > 0 ? `staff ${account.staffmodlevel}` : null, account.banned_until ? 'banned' : null].filter(Boolean).join(', ');
        console.log(`  ${String(account.id).padStart(6)}  ${account.username.padEnd(12)}  ${account.email}  ip=${account.registration_ip ?? '-'}  group=${account.registration_group ?? '-'}  ${flags}`);
    }
}

const [command, ...args] = process.argv.slice(2);

console.log(`Using the ${Environment.db.backend} backend.`);

switch (command) {
    case 'create-staff':
        await createStaff(args);
        break;
    case 'reset-password':
        await resetPassword(args);
        break;
    case 'ban-ip':
        await banIp(args);
        break;
    case 'find-alts':
        await findAlts(args);
        break;
    default:
        fail(USAGE);
}

await db.destroy();
