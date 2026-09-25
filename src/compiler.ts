import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A contiguous block of assembled bytes, e.g. one section.
 */
export interface Segment {
    address: number;
    data: Buffer;
}

/**
 * A line of the listing file which generated some bytes.
 */
export interface ListingLine {
    file: string;
    line: number;
    address: number;
    length: number;
    source: string;
}

export class CompiledProg {
    public constructor(
        /**
         * All the assembled bytes, from origin up to the end of the last
         * segment. Any gaps between segments are filled with zeros.
         */
        public data: Buffer,
        /**
         * The address of the first byte of data.
         */
        public origin: number,
        public segments: Segment[],
        public symbols: { [symbol: string]: number },
        public list: string[],
        public lines: ListingLine[]
    ) {}

    public dumpList() {
        for (const line of this.list) {
            console.log(line);
        }
    }
}

export interface CompilerOptions {
    /**
     * The z80asm executable. Defaults to $ZAT_Z80ASM, or z88dk.z88dk-z80asm.
     */
    z80asm?: string;
    /**
     * The directory in which temporary directories are created. Defaults to
     * $ZAT_TMPDIR, or node_modules/.cache/zat in the current directory. This
     * isn't os.tmpdir() because the snap version of z88dk has a private /tmp.
     */
    tmpDir?: string;
    /**
     * Extra command line arguments to pass to z80asm, e.g. ['-mz180'].
     */
    args?: string[];
}

export class Compiler {
    private z80asm: string;
    private tmpDir: string;
    private args: string[];

    public constructor(options: CompilerOptions = {}) {
        this.z80asm =
            options.z80asm || process.env.ZAT_Z80ASM || 'z88dk.z88dk-z80asm';
        this.tmpDir =
            options.tmpDir ||
            process.env.ZAT_TMPDIR ||
            path.join(process.cwd(), 'node_modules', '.cache', 'zat');
        this.args = options.args || [];
    }

    /**
     * Compile some code using z80asm. includeDir is used to find any
     * included files, and defaults to the current directory. name is used
     * in error messages and the listing.
     */
    public compile(
        code: string,
        includeDir = process.cwd(),
        name = 'code'
    ): CompiledProg {
        fs.mkdirSync(this.tmpDir, { recursive: true });
        const dir = fs.mkdtempSync(path.join(this.tmpDir, 'asm-'));
        try {
            const base = 'prog';
            const asmFile = path.join(dir, `${base}.asm`);
            // z80asm leaves constants which aren't used out of the map file,
            // unless they're public, so make them public
            const constants = findConstants(code.split('\n'));
            fs.writeFileSync(asmFile, makePublic(code, constants));
            const asmFileRegExp = new RegExp(escapeRegExp(asmFile), 'g');
            const assemble = () => {
                try {
                    execFileSync(
                        this.z80asm,
                        [
                            '-b',
                            '-l',
                            '-m',
                            `-I${path.resolve(includeDir)}`,
                            ...this.args,
                            asmFile,
                        ],
                        { stdio: 'pipe' }
                    );
                } catch (e) {
                    const output = `${e.stderr || ''}${e.stdout || ''}`.trim();
                    throw new Error(
                        `z80asm failed: ${output || e.message}`.replace(
                            asmFileRegExp,
                            name
                        )
                    );
                }
                const map = readMap(path.join(dir, `${base}.map`));
                const list = fs
                    .readFileSync(path.join(dir, `${base}.lis`))
                    .toString()
                    .replace(asmFileRegExp, name)
                    .split('\n');
                return { map, list };
            };

            let { map, list } = assemble();
            // The listing also has the lines of any included files. If they
            // have constants which are missing, assemble again.
            const missing = findConstants(listingSource(list)).filter(
                (constant) => !(constant.toLowerCase() in map.symbols)
            );
            if (missing.length > 0) {
                fs.writeFileSync(
                    asmFile,
                    makePublic(code, [...constants, ...missing])
                );
                ({ map, list } = assemble());
            }

            const segments = readSegments(dir, base, map.heads);
            const lines = parseListing(list, map.heads);
            const [data, origin] = combineSegments(segments);
            return new CompiledProg(
                data,
                origin,
                segments,
                map.symbols,
                list,
                lines
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public compileFile(filename: string): CompiledProg {
        let buffer = fs.readFileSync(filename);
        return this.compile(
            buffer.toString(),
            path.dirname(filename),
            filename
        );
    }
}

interface MapInfo {
    symbols: { [symbol: string]: number };
    /**
     * Start address of each section, by name. The default section is ''.
     */
    heads: { [section: string]: number };
}

/**
 * Lines in the map file look like:
 * newstart                        = $0020 ; addr, local, , prog, two, prog.asm:6
 */
function readMap(filename: string): MapInfo {
    const symbols = {};
    const heads = {};
    const text = fs.readFileSync(filename).toString();
    for (const line of text.split('\n')) {
        const match = /^(\S+)\s*=\s*\$([0-9a-fA-F]+)/.exec(line);
        if (!match) {
            continue;
        }
        const [, name, hex] = match;
        const value = parseInt(hex, 16);
        if (name === '__head') {
            heads[''] = value;
        } else if (/^__.+_head$/.test(name)) {
            heads[name.slice(2, -5)] = value;
        } else if (!name.startsWith('__')) {
            symbols[name.toLowerCase()] = value;
        }
    }
    return { symbols, heads };
}

/**
 * z80asm writes one binary per section when the sections have their own
 * origins: prog.bin for the first, and prog_<section>.bin for the others.
 */
function readSegments(
    dir: string,
    base: string,
    heads: { [section: string]: number }
): Segment[] {
    const segments: Segment[] = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.bin')) {
            continue;
        }
        const name = file.slice(0, -4);
        let section: string;
        if (name === base) {
            section = '';
        } else if (name.startsWith(`${base}_`)) {
            section = name.slice(base.length + 1);
        } else {
            continue;
        }
        const address = heads[section] || 0;
        const data = fs.readFileSync(path.join(dir, file));
        if (data.length > 0) {
            segments.push({ address, data });
        }
    }
    return segments.sort((a, b) => a.address - b.address);
}

function combineSegments(segments: Segment[]): [Buffer, number] {
    if (segments.length === 0) {
        return [Buffer.alloc(0), 0];
    }
    const origin = segments[0].address;
    const end = Math.max(...segments.map((s) => s.address + s.data.length));
    const data = Buffer.alloc(end - origin);
    for (const segment of segments) {
        segment.data.copy(data, segment.address - origin);
    }
    return [data, origin];
}

/**
 * Lines in the listing file look like:
 *      7  0000  c30000             jp start
 * Addresses are relative to the start of the section, so the section head
 * is added to them.
 */
function parseListing(
    list: string[],
    heads: { [section: string]: number }
): ListingLine[] {
    const lines: ListingLine[] = [];
    let file = '';
    let section = '';
    for (const text of list) {
        const fileMatch = /^(\S.*):$/.exec(text);
        if (fileMatch) {
            file = fileMatch[1];
            continue;
        }
        const sectionMatch = /^\s*\d+\s+section\s+(\w+)/i.exec(text);
        if (sectionMatch) {
            section = sectionMatch[1];
            continue;
        }
        const match =
            /^\s*(\d+)\s+([0-9a-f]{4})\s+((?:[0-9a-f]{2})+)(?:\s+(.*))?$/.exec(
                text
            );
        if (!match) {
            continue;
        }
        const [, line, address, bytes, source] = match;
        lines.push({
            file,
            line: parseInt(line, 10),
            address: (heads[section] || 0) + parseInt(address, 16),
            length: bytes.length / 2,
            source: source || '',
        });
    }
    return lines;
}

/**
 * The source code lines in a listing. This includes lines from included
 * files, and lines which weren't assembled because of if statements.
 */
function listingSource(list: string[]): string[] {
    return list
        .map((text) => /^\s*\d+\s+(.*)$/.exec(text)?.[1])
        .filter((source) => source !== undefined);
}

/**
 * Find the names of constants defined with equ, defc or =, in some lines of
 * source code.
 */
function findConstants(lines: string[]): string[] {
    const constants = new Set<string>();
    for (const line of lines) {
        const source = line.replace(/;.*$/, '');
        const equ = /^\s*\.?([A-Za-z_]\w*)\s*:?\s*(?:equ\b|=(?!=))/i.exec(
            source
        );
        if (equ) {
            constants.add(equ[1]);
            continue;
        }
        const defc = /^\s*defc\s+(.*)$/i.exec(source);
        if (defc) {
            for (const [, constant] of defc[1].matchAll(
                /(?:^|,)\s*([A-Za-z_]\w*)\s*=/g
            )) {
                constants.add(constant);
            }
        }
    }
    return [...constants];
}

/**
 * Add public declarations for constants to the end of some code. They're in
 * ifdefs, as a constant may be in an if statement which wasn't assembled.
 */
function makePublic(code: string, constants: string[]): string {
    if (constants.length === 0) {
        return code;
    }
    return [
        code,
        '; Added by zat, so that unused constants are in the map file',
        ...constants.map(
            (constant) => `ifdef ${constant}\npublic ${constant}\nendif`
        ),
        '',
    ].join('\n');
}

function escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
