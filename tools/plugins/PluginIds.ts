/**
 * Reserved id ranges for content shipped by plugins.
 *
 * Upstream allocates ids densely from 0, so anything a plugin claims just above the current
 * maximum will collide the moment upstream adds content. Plugins therefore allocate from a
 * reserved base far above upstream's range, which also makes plugin content trivially
 * identifiable: every id at or above the base belongs to a plugin and nothing else.
 *
 * Sparse ids are safe. The packers iterate 0..max and write an empty entry for gaps
 * (`ObjConfig.ts` falls through to `client.next()`), the versionlist writes version 0 for a
 * missing model, and the client's on-demand loop never requests a version-0 file. The cost is
 * memory for default config objects across the gap - roughly 13-15 MB for the bases below.
 */
export const PLUGIN_PACK_TYPES = ['obj', 'loc', 'npc', 'model', 'seq', 'spotanim'] as const;

export type PluginPackType = (typeof PLUGIN_PACK_TYPES)[number];

export const PLUGIN_ID_BASE: Record<PluginPackType, number> = {
    obj: 20000,
    loc: 20000,
    model: 20000,
    seq: 20000,
    spotanim: 20000,

    // npc is the exception. Npc type ids are packed into 11 bits by the player/npc info encoder
    // (`src/network/rsbuf/info.ts` -> `pbit(11, ntype)`), and `pbit` masks silently rather than
    // throwing, so an id of 2048 or above renders as a completely different npc with no error.
    npc: 1792
};

/**
 * Exclusive upper bound per type. Beyond the protocol limits, the packers build their index
 * buffers with `Packet.alloc(3)` - a fixed 100,000 bytes with no growth - at 2 bytes per entry,
 * so any transmitted pack must stay under 50,000 entries or the build throws a RangeError.
 */
export const PLUGIN_ID_CEILING: Record<PluginPackType, number> = {
    obj: 50000,
    loc: 50000,
    model: 50000,
    seq: 50000,
    spotanim: 50000,

    // 11-bit protocol limit, not a buffer limit - this one is hard.
    npc: 2048
};

export function isPluginPackType(value: string): value is PluginPackType {
    return (PLUGIN_PACK_TYPES as readonly string[]).includes(value);
}
