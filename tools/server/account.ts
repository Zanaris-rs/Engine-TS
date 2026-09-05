/**
 * Staff account tools, run against whatever backend data/config/world.json
 * selects:
 *
 *   npm run account -- create-staff <name> <email> <password> [level] [--force]
 *   npm run account -- reset-password <name> <newpassword>
 *   npm run account -- ban-ip <ip>
 *   npm run account -- find-alts <email|ip|ip-group>
 *   npm run account -- send-notice <name> <subject> <body> [--from <staff>]
 *   npm run account -- tickets [open|closed|all]
 *   npm run account -- punishments [name]
 *   npm run account -- lift <name> [--from <staff>]
 *
 * With account.autoCreate off there is no other way to make the first account,
 * and with no mailer there is no other way to recover a lost password. The two
 * message centre commands are the shell-side twin of the website's staff
 * inbox: the same tables, no session and no password re-type, because whoever
 * can run this already has the database.
 *
 * `lift` is the shell twin of the website's `staff_lift`, and it is the reason
 * the operator runbook can stop telling people to unban with raw psql: an
 * `UPDATE account SET banned_until = NULL` clears the state and leaves the
 * public record on /bans still saying the player is serving a ban nobody can
 * find. Lifting is two writes, and this does both.
 */
import * as bcrypt from 'bcrypt-ts';

import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import { liftPunishmentsQuery, NOTICE_KIND, punishmentsQuery } from '#/server/login/MessageCentre.js';
import { checkPassword, checkUsername, ipGroup, isValidEmail, normalizeEmail } from '#/util/Account.js';
import Environment from '#/util/Environment.js';
import { toDisplayName, toSafeName } from '#/util/JString.js';

const USAGE = `Usage:
  account.ts create-staff <name> <email> <password> [level] [--force]
  account.ts reset-password <name> <newpassword>
  account.ts ban-ip <ip>
  account.ts find-alts <email|ip|ip-group>
  account.ts send-notice <name> <subject> <body> [--from <staff>]
  account.ts tickets [open|closed|all]
  account.ts punishments [name]
  account.ts lift <name> [--from <staff>]`;

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

        // --force overrides the *reservation*, not the encoding. Lower-casing
        // and swapping spaces by hand is not the same function the login
        // protocol runs: base37 also drops trailing underscores, so `Mod_Ash_`
        // would have been stored as `mod_ash_` and then never matched the
        // `mod_ash` the client sends. toSafeName is the one the rest of the
        // server agrees on, and it is what checkUsername already tested.
        return toSafeName(input);
    }

    return check.username;
}

/**
 * `--from <staff>` and the arguments around it, for the two commands that
 * record who did the thing.
 *
 * A trailing `--from` used to be dropped silently, and the notice went out
 * signed by nobody - the one thing the flag exists to prevent.
 */
function takeFrom(args: string[]): { from: string | null; rest: string[] } {
    const fromIndex = args.indexOf('--from');
    const from = fromIndex === -1 ? null : args[fromIndex + 1];
    const rest = fromIndex === -1 ? args : [...args.slice(0, fromIndex), ...args.slice(fromIndex + 2)];

    if (fromIndex !== -1 && !from) {
        fail(`--from needs a staff username.\n\n${USAGE}`);
    }

    return { from: from ?? null, rest };
}

/** The account named by `--from`, or undefined when nobody was named. */
async function loadActor(from: string | null) {
    if (!from) {
        return undefined;
    }

    const username = resolveUsername(from, true);
    const actor = await db.selectFrom('account').select(['id', 'username']).where('username', '=', username).executeTakeFirst();

    if (!actor) {
        fail(`No account called '${username}' to act as.`);
    }

    return actor;
}

/** postgres hands back a Date and sqlite a string; fromDbDate reads either. */
function formatStamp(value: Date | string | null): string {
    return value === null ? '-' : fromDbDate(value).toISOString().slice(0, 19).replace('T', ' ');
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

/**
 * The one way to reach a player's Message Centre without the website. Kind
 * `notice`, no ticket, written in the caller's own name if they name
 * themselves - `--from <staff>` - and by nobody otherwise, which is what the
 * welcome message and the automated bans already do.
 */
async function sendNotice(args: string[]) {
    const { from, rest } = takeFrom(args);

    const [name, rawSubject, rawBody] = rest;

    if (!name || !rawSubject || !rawBody) {
        fail(USAGE);
    }

    // the same caps the SQL API enforces, so a notice sent here cannot be one
    // the website would have refused. Measured before trimming and stored
    // after, exactly as accounts.staff_notice does it.
    if (rawSubject.length > 120) {
        fail(`The subject is ${rawSubject.length} characters; the cap is 120.`);
    }

    if (rawBody.length > 4000) {
        fail(`The body is ${rawBody.length} characters; the cap is 4000.`);
    }

    const subject = rawSubject.trim();
    const body = rawBody.trim();

    if (subject.length === 0 || body.length === 0) {
        fail('A notice needs a subject and a body; whitespace is not one.');
    }

    const username = resolveUsername(name, true);

    const account = await db.selectFrom('account').select(['id', 'username']).where('username', '=', username).executeTakeFirst();
    if (!account) {
        fail(`No account called '${username}'.`);
    }

    const author = await loadActor(from);

    await db
        .insertInto('account_message')
        .values({
            account_id: account.id,
            kind: NOTICE_KIND,
            subject,
            body,
            created_by_account_id: author?.id ?? null
        })
        .execute();

    // The audit row /staff/reports reads, so a notice sent from the shell is
    // as visible as one sent from the site. Only when a person is named: an
    // unattributed notice is the system talking, and there is no actor.
    //
    // 'staff_notice_cli', not 'staff_notice': the website's function counts
    // its own action name over the last hour for its 20-per-actor throttle, so
    // sharing the name would let shell notices - which are not rate limited,
    // and cannot be, since whoever runs this has the database - quietly spend
    // a moderator's website allowance. It also says which door it came in by.
    if (author) {
        await db.insertInto('staff_action').values({ actor_account_id: author.id, action: 'staff_notice_cli', target: account.username }).execute();
    }

    const unread = await db
        .selectFrom('account_message')
        .select(eb => eb.fn.countAll().as('unread'))
        .where('account_id', '=', account.id)
        .where('read_at', 'is', null)
        .executeTakeFirst();

    console.log(`Sent a notice to ${toDisplayName(account.username)} (id ${account.id})${author ? ` from ${toDisplayName(author.username)}` : ''}.`);
    console.log(`They now have ${Number(unread?.unread ?? 0)} unread message(s), which is what the welcome screen will say on their next login.`);
}

/**
 * The staff inbox, read-only, for a host with no browser in front of it.
 * Newest first, and the ones waiting on staff are marked, because that is the
 * only ordering anyone actually wants.
 */
async function tickets(args: string[]) {
    const [filter = 'open'] = args;

    if (!['open', 'closed', 'all'].includes(filter)) {
        fail(USAGE);
    }

    let query = db.selectFrom('ticket').innerJoin('account', 'account.id', 'ticket.account_id').select(['ticket.id', 'ticket.kind', 'ticket.subject', 'ticket.status', 'ticket.updated_at', 'account.username']);

    if (filter !== 'all') {
        query = query.where('ticket.status', '=', filter);
    }

    const rows = await query.orderBy('ticket.updated_at', 'desc').limit(50).execute();

    if (rows.length === 0) {
        console.log(`No ${filter === 'all' ? '' : filter + ' '}tickets.`);
        return;
    }

    const ids = rows.map(row => row.id);

    // One query for every ticket's newest message rather than one per row.
    // max(id) rather than max(created_at): sqlite stores seconds, so two
    // messages in the same second are a tie there and the id is the only
    // thing that actually orders them.
    const newest = await db
        .selectFrom('ticket_message')
        .innerJoin(
            eb =>
                eb
                    .selectFrom('ticket_message')
                    .select(({ fn }) => ['ticket_id', fn.max('id').as('id')])
                    .where('ticket_id', 'in', ids)
                    .groupBy('ticket_id')
                    .as('latest'),
            join => join.onRef('latest.id', '=', 'ticket_message.id')
        )
        .select(['ticket_message.ticket_id', 'ticket_message.from_staff'])
        .execute();

    // sqlite hands booleans back as 0/1, which is why this tests truthiness
    const awaitingStaff = new Map(newest.map(row => [row.ticket_id, !row.from_staff]));

    console.log(`${rows.length} ${filter === 'all' ? '' : filter + ' '}ticket(s), newest first:`);
    for (const row of rows) {
        const waiting = awaitingStaff.get(row.id) ? 'awaiting staff' : '';
        // postgres hands back a Date and sqlite a string; fromDbDate reads
        // either, and String(aDate) would have printed a local-time sentence
        const updated = fromDbDate(row.updated_at).toISOString().slice(0, 19).replace('T', ' ');

        // the display name, as send-notice prints it: 'mod_matt' is stored,
        // 'Mod Matt' is what staff see everywhere else
        console.log(`  ${String(row.id).padStart(6)}  ${row.status.padEnd(6)}  ${row.kind.padEnd(6)}  ${toDisplayName(row.username).padEnd(12)}  ${updated}  ${row.subject}  ${waiting}`);
    }

    console.log('Replies go through the website staff inbox, which audits them; this command only reads.');
}

/**
 * The permanent record, exactly as /bans shows it. No issuer and no lifter:
 * those columns exist for a staff audit, and the public page has never named
 * them - so neither does the shell, and nobody has to remember which of the
 * two views they are looking at.
 */
async function punishments(args: string[]) {
    const [name] = args;

    let account: { id: number; username: string } | undefined;

    if (name) {
        const username = resolveUsername(name, true);
        account = await db.selectFrom('account').select(['id', 'username']).where('username', '=', username).executeTakeFirst();

        if (!account) {
            fail(`No account called '${username}'.`);
        }
    }

    const rows = await punishmentsQuery(db, account?.id ?? null, 50).execute();

    if (rows.length === 0) {
        console.log(account ? `${toDisplayName(account.username)} has never been banned or muted.` : 'Nothing has been banned or muted.');
        return;
    }

    console.log(`${rows.length} punishment(s)${account ? ` for ${toDisplayName(account.username)}` : ''}, newest first:`);
    for (const row of rows) {
        // sqlite hands booleans back as 0/1, which is why these test truthiness
        const by = row.automated ? 'automated' : 'a moderator';
        const lifted = row.lifted_at ? `lifted ${formatStamp(row.lifted_at)}` : '';

        console.log(
            `  ${String(row.id).padStart(6)}  ${row.kind.padEnd(4)}  ${toDisplayName(row.username).padEnd(12)}  issued ${formatStamp(row.issued_at)}  until ${formatStamp(row.until)}  ${by.padEnd(11)}  ${lifted}${row.note ? `  "${row.note}"` : ''}`
        );
    }
}

/**
 * Undo a ban and a mute, both halves of it.
 *
 * `account.banned_until` is the state that stops a login; `punishment` is the
 * record /bans reads. Clearing only the first - which is what unbanning by
 * hand in psql does - leaves the public page saying somebody is serving a ban
 * they are not, forever, because nothing ever revisits that row.
 *
 * Only punishments still in force are stamped. One that already expired was
 * not lifted by anybody, and saying otherwise would credit a moderator with
 * the passage of time.
 */
async function lift(args: string[]) {
    const { from, rest } = takeFrom(args);
    const [name] = rest;

    if (!name) {
        fail(USAGE);
    }

    const username = resolveUsername(name, true);

    const account = await db.selectFrom('account').select(['id', 'username', 'banned_until', 'muted_until']).where('username', '=', username).executeTakeFirst();
    if (!account) {
        fail(`No account called '${username}'.`);
    }

    const actor = await loadActor(from);

    const was = [account.banned_until ? `banned until ${formatStamp(account.banned_until)}` : null, account.muted_until ? `muted until ${formatStamp(account.muted_until)}` : null].filter(Boolean).join(' and ');

    await db.updateTable('account').set({ banned_until: null, muted_until: null }).where('id', '=', account.id).execute();

    const now = new Date();
    const lifted = await liftPunishmentsQuery(db, account.id, toDbDate(now), actor?.id ?? null, now).executeTakeFirst();

    // the same audit row the website's staff_lift writes, and named for the
    // door it came in by - see the note on staff_notice_cli above
    if (actor) {
        await db.insertInto('staff_action').values({ actor_account_id: actor.id, action: 'staff_lift_cli', target: account.username }).execute();
    }

    console.log(`Lifted ${toDisplayName(account.username)} (id ${account.id})${actor ? ` as ${toDisplayName(actor.username)}` : ''}: ${was || 'nothing was in force'}.`);
    console.log(`${Number(lifted?.numUpdatedRows ?? 0)} punishment row(s) marked lifted. They stay on the public record; "lifted" is what changes.`);

    if (!actor) {
        console.log('No --from, so the record does not say who lifted it. Pass one if this was a person.');
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
    case 'send-notice':
        await sendNotice(args);
        break;
    case 'tickets':
        await tickets(args);
        break;
    case 'punishments':
        await punishments(args);
        break;
    case 'lift':
        await lift(args);
        break;
    default:
        fail(USAGE);
}

await db.destroy();
