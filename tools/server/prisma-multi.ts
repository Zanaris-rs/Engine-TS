import child_process from 'child_process';
import path from 'path';

import { getDatabaseUrl, loadWorldConfig } from '#/util/WorldConfig.js';

const args = process.argv.slice(2);

const config = loadWorldConfig();
const schema = config.db.backend === 'postgres' ? 'prisma/postgres/schema.prisma' : 'prisma/multiworld/schema.prisma';

if (!args.some(arg => arg === '--schema' || arg.startsWith('--schema='))) {
    args.push('--schema', schema);
}

const databaseUrl = getDatabaseUrl(config);

if (databaseUrl.length === 0) {
    console.error(`No database url for backend '${config.db.backend}'. Set DATABASE_URL, or db.url in data/config/world.json.`);
    process.exit(1);
}

const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

const result = child_process.spawnSync(process.execPath, [prismaCli, ...args], {
    stdio: 'inherit',
    env: {
        ...process.env,
        DATABASE_URL: databaseUrl
    }
});

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);
