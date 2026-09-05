/**
 * The economy census: what exists in the game, and what entered or left it.
 *
 *   npm run economy [--dry-run] [--profile <name>] [--players <dir>] [--skip-unreadable]
 *
 * Every permanent inventory of every save file under `data/players/<profile>`,
 * summed by item id, into one `economy_snapshot` row - plus one `economy_flow`
 * row per tracked item whose count moved since the previous run. Nothing it
 * writes names an account: the public /economy page can say a partyhat entered
 * the game without saying whose it is, because the tool never knew.
 *
 * It counts *saves*, which is the honest definition available: shop stock and
 * ground items are rebuilt or dropped by the world and are nobody's property,
 * and an online player is counted as of their last autosave. On the hub it runs
 * hourly under systemd with `WorkingDirectory=/opt/lostcity/hub`, reading
 * `DATABASE_URL`/`DATABASE_SSL_CA` from `/etc/lostcity/hub.env` exactly as the
 * login server does.
 *
 * Nothing here imports `World` (see SaveReader), so the census costs one
 * process and a few tens of milliseconds, not an engine.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Environment from '#/util/Environment.js';
import { fallbackInvLookup, InvLookup, invLookupFromCache, readSave } from '#tools/server/SaveReader.js';

const USAGE = `Usage:
  economy.ts [--dry-run] [--profile <name>] [--players <dir>] [--skip-unreadable]

  --dry-run           count and print, write nothing (and open no database)
  --profile <name>    census this profile instead of node.profile
  --players <dir>     census this directory instead of data/players/<profile>
  --skip-unreadable   write the census even though some saves could not be read`;

/** The engine's own tree, whatever cwd the census was started from. */
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface TrackedItem {
    id: number;
    name: string;
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function takeFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) {
        return false;
    }

    args.splice(index, 1);
    return true;
}

function takeOption(args: string[], flag: string): string | null {
    const index = args.indexOf(flag);
    if (index === -1) {
        return null;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        fail(`${flag} needs a value.\n\n${USAGE}`);
    }

    args.splice(index, 2);
    return value;
}

/**
 * The tracked list, from the fleet's copy if it shipped one and from the
 * engine's own otherwise. The hub's working directory gets world.json, the pems
 * and (optionally) this file from deploy.sh - everything else it resolves
 * through symlinks into the engine tree - so the bundled list is what makes the
 * census work on a box nobody has configured.
 */
function loadTracked(): { items: TrackedItem[]; source: string } {
    const override = path.resolve('data/config/economy.json');
    const bundled = path.join(ENGINE_ROOT, 'data/config/economy.json');
    const source = fs.existsSync(override) ? override : bundled;

    if (!fs.existsSync(source)) {
        fail(`No tracked-item list: ${bundled} is missing from the engine tree.`);
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch (err) {
        fail(`${source} is not valid JSON: ${(err as Error).message}`);
    }

    const items = parsed?.tracked;
    if (!Array.isArray(items)) {
        fail(`${source} has no "tracked" array.`);
    }

    const tracked: TrackedItem[] = [];
    for (const item of items) {
        if (typeof item?.id !== 'number' || !Number.isInteger(item.id) || item.id < 0) {
            fail(`${source}: every tracked entry needs an integer "id" (${JSON.stringify(item)}).`);
        }

        tracked.push({ id: item.id, name: typeof item.name === 'string' ? item.name : `item ${item.id}` });
    }

    return { items: tracked, source };
}

/**
 * Inv metadata from the cache config. `data/pack` is a symlink into the engine
 * tree in every deployed working directory, and the engine's own copy is the
 * fallback for a cwd that has none; a machine with no build at all falls back
 * to the three permanent invs by id, which is enough to census a save from
 * version 5 on (those carry their own sizes).
 */
function loadInvs(): InvLookup {
    for (const dir of [path.resolve('data/pack'), path.join(ENGINE_ROOT, 'data/pack')]) {
        const lookup = invLookupFromCache(dir);
        if (lookup) {
            return lookup;
        }
    }

    console.warn('[economy] no data/pack/server/inv.dat: falling back to the permanent invs by id. Run npm run build if this is not a hub.');
    return fallbackInvLookup();
}

interface Census {
    players: number;
    unreadable: string[];
    newestSave: Date | null;
    items: Map<number, number>;
}

function census(dir: string, invs: InvLookup): Census {
    const result: Census = { players: 0, unreadable: [], newestSave: null, items: new Map() };

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.sav')) {
            continue;
        }

        const file = path.join(dir, entry.name);
        const username = entry.name.slice(0, -4);

        result.players++;

        const stat = fs.statSync(file);
        if (!result.newestSave || stat.mtime > result.newestSave) {
            result.newestSave = stat.mtime;
        }

        let save;
        try {
            save = readSave(username, new Uint8Array(fs.readFileSync(file)), invs);
        } catch (err) {
            result.unreadable.push(`${entry.name}: ${(err as Error).message}`);
            continue;
        }

        for (const objs of Object.values(save.inventories)) {
            for (const obj of objs) {
                result.items.set(obj.id, (result.items.get(obj.id) ?? 0) + obj.count);
            }
        }
    }

    return result;
}

/** {id: count}, by ascending id, so two snapshots can be diffed by eye. */
function toCounts(items: Map<number, number>, ids?: number[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const id of (ids ?? [...items.keys()]).slice().sort((a, b) => a - b)) {
        counts[id] = items.get(id) ?? 0;
    }

    return counts;
}

/**
 * `items`/`tracked` are jsonb on postgres and text everywhere else, and a JSON
 * string is what all three take: postgres parses a text parameter into the
 * jsonb column, sqlite and mysql store it as written. Reading one back is the
 * asymmetric half - pg hands back a parsed object - so callers of the previous
 * snapshot have to cope with both.
 */
function toJsonColumn(value: Record<string, number>): string {
    return JSON.stringify(value);
}

function fromJsonColumn(value: unknown): Record<string, number> {
    if (typeof value === 'string') {
        return JSON.parse(value);
    }

    return (value ?? {}) as Record<string, number>;
}

const args = process.argv.slice(2);

if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    console.log(USAGE);
    process.exit(0);
}

const dryRun = takeFlag(args, '--dry-run');
const skipUnreadable = takeFlag(args, '--skip-unreadable');
const profile = takeOption(args, '--profile') ?? Environment.node.profile;
const playersDir = takeOption(args, '--players') ?? path.join('data/players', profile);

if (args.length > 0) {
    fail(`Unrecognized argument '${args[0]}'.\n\n${USAGE}`);
}

if (!fs.existsSync(playersDir)) {
    fail(`No save directory at ${path.resolve(playersDir)}. Pass --players <dir> or --profile <name>.`);
}

const started = Date.now();
const tracked = loadTracked();
console.log(`[economy] tracking ${tracked.items.length} items from ${tracked.source}`);

const counted = census(playersDir, loadInvs());

if (counted.unreadable.length > 0) {
    for (const line of counted.unreadable) {
        console.error(`[economy] unreadable save ${line}`);
    }

    if (!skipUnreadable) {
        // a census missing somebody's bank is not a small census, it is a wrong
        // one: every item in that file would read as having left the game
        fail(`[economy] ${counted.unreadable.length} of ${counted.players} saves could not be read; nothing written. Pass --skip-unreadable to census the rest anyway.`);
    }
}

const items = toCounts(counted.items);
const trackedCounts = toCounts(
    counted.items,
    tracked.items.map(item => item.id)
);
const coins = counted.items.get(995) ?? 0;
const elapsed = Date.now() - started;
const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);

const summary =
    `${profile}: ${counted.players.toLocaleString('en-US')} players, ${coins.toLocaleString('en-US')} coins, ` +
    `${Object.keys(items).length.toLocaleString('en-US')} item ids, newest save ${counted.newestSave?.toISOString() ?? 'never'}` +
    ` (${elapsed} ms, ${rss} MiB rss)`;

if (dryRun) {
    console.log(`[economy] ${summary}; dry run, nothing written`);
    console.log(`[economy] tracked: ${tracked.items.map(item => `${item.name} ${trackedCounts[item.id]}`).join(', ')}`);
} else {
    // imported here and not at the top so a dry run opens no database at all -
    // importing the module connects
    const { db, toDbDate } = await import('#/db/query.js');

    const previous = await db.selectFrom('economy_snapshot').select(['id', 'tracked']).where('profile', '=', profile).orderBy('taken_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();

    const takenAt = new Date();
    await db
        .insertInto('economy_snapshot')
        .values({
            taken_at: toDbDate(takenAt),
            profile,
            players: counted.players,
            coins,
            items: toJsonColumn(items),
            tracked: toJsonColumn(trackedCounts)
        })
        .executeTakeFirst();

    const flows: { taken_at: string; profile: string; item_id: number; delta: number }[] = [];
    if (previous) {
        const before = fromJsonColumn(previous.tracked);

        for (const item of tracked.items) {
            // an item the previous census was not tracking has no baseline, and
            // "everything that exists entered the game this hour" is a lie
            if (!(item.id in before)) {
                continue;
            }

            const delta = trackedCounts[item.id] - before[item.id];
            if (delta !== 0) {
                flows.push({ taken_at: toDbDate(takenAt), profile, item_id: item.id, delta });
            }
        }

        if (flows.length > 0) {
            await db.insertInto('economy_flow').values(flows).execute();
        }
    }

    await db.destroy();

    const flowed = flows.map(flow => `${tracked.items.find(item => item.id === flow.item_id)?.name ?? flow.item_id} ${flow.delta > 0 ? '+' : ''}${flow.delta}`);
    const wrote = previous ? `${flows.length} flow rows${flowed.length > 0 ? ` (${flowed.join(', ')})` : ''}` : 'no flow rows (first census for this profile: nothing to compare it to)';

    console.log(`[economy] ${summary}; wrote a snapshot and ${wrote}`);
}
