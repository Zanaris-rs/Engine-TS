/**
 * Minimal reader for the old-format `.ob2` model header.
 *
 * Stream order and the 18-byte trailer are taken from the 289 client's own decoder,
 * `Client-Java/src/main/java/jagex2/dash3d/Model.java` (see the `arg0.length - 18` block).
 *
 * The reason this exists: a model carrying face labels (TSKIN) or vertex labels (VSKIN) is
 * *rigged*, and rig labels are re-assigned per model between revisions. Geometry, colours and
 * face indices port across revisions untouched, but labels do not - so a rigged model imported
 * from another revision animates into mangled limbs. Detecting that at import time is much
 * cheaper than discovering it in game.
 */
export type Ob2Info = {
    vertexCount: number;
    faceCount: number;
    texturedFaceCount: number;
    /** TSKIN - per-face animation labels */
    hasFaceLabels: boolean;
    /** VSKIN - per-vertex animation labels */
    hasVertexLabels: boolean;
    /** true when the model carries animation rig data and so is revision-specific */
    rigged: boolean;
    /** computed body length matches the file, i.e. the model parses cleanly */
    wellFormed: boolean;
    expectedLength: number;
    actualLength: number;
};

export function readOb2(data: Buffer): Ob2Info {
    if (data.length < 18) {
        return {
            vertexCount: 0,
            faceCount: 0,
            texturedFaceCount: 0,
            hasFaceLabels: false,
            hasVertexLabels: false,
            rigged: false,
            wellFormed: false,
            expectedLength: 0,
            actualLength: data.length
        };
    }

    const t = data.subarray(data.length - 18);
    const g2 = (i: number): number => (t[i] << 8) | t[i + 1];

    const vertexCount = g2(0);
    const faceCount = g2(2);
    const texturedFaceCount = t[4];
    const hasFaceInfo = t[5] === 1;
    const hasPriority = t[6] === 255;
    const hasAlpha = t[7] === 1;
    const hasFaceLabels = t[8] === 1;
    const hasVertexLabels = t[9] === 1;
    const vertexXLen = g2(10);
    const vertexYLen = g2(12);
    const vertexZLen = g2(14);
    const faceVertexLen = g2(16);

    const expectedLength =
        vertexCount +
        faceCount +
        (hasPriority ? faceCount : 0) +
        (hasFaceLabels ? faceCount : 0) +
        (hasFaceInfo ? faceCount : 0) +
        (hasVertexLabels ? vertexCount : 0) +
        (hasAlpha ? faceCount : 0) +
        faceVertexLen +
        faceCount * 2 +
        texturedFaceCount * 6 +
        vertexXLen +
        vertexYLen +
        vertexZLen;

    return {
        vertexCount,
        faceCount,
        texturedFaceCount,
        hasFaceLabels,
        hasVertexLabels,
        rigged: hasFaceLabels || hasVertexLabels,
        wellFormed: expectedLength === data.length - 18,
        expectedLength,
        actualLength: data.length - 18
    };
}
