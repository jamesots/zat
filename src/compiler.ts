import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { compile as mazCompile, FileResolver, Programme } from 'maz';

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
    /**
     * Whether the line is data rather than code: a data directive such as
     * db, or a macro which only contains data directives.
     */
    data: boolean;
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

/**
 * The assemblers zat can use: maz, which is installed with zat, or z80asm
 * from z88dk, which has to be installed separately.
 */
export type Assembler = 'maz' | 'z80asm';

const ASSEMBLERS: readonly string[] = ['maz', 'z80asm'];

export interface CompilerOptions {
    /**
     * The assembler to use. Defaults to $ZAT_ASSEMBLER, or maz.
     */
    assembler?: Assembler;
    /**
     * The z80asm executable. Defaults to $ZAT_Z80ASM, or z88dk.z88dk-z80asm.
     */
    z80asm?: string;
    /**
     * The directory in which the cache directory and z80asm's temporary
     * directories are created. Defaults to $ZAT_TMPDIR, or
     * node_modules/.cache/zat in the current directory. This isn't
     * os.tmpdir() because the snap version of z88dk has a private /tmp.
     */
    tmpDir?: string;
    /**
     * Extra command line arguments to pass to z80asm, e.g. ['-mz180'].
     */
    args?: string[];
    /**
     * Whether to cache assembled code, in memory and in a cache directory
     * in tmpDir. Defaults to true, unless $ZAT_CACHE is 0.
     */
    cache?: boolean;
}

/**
 * Change this when the cached data, or how it's made, changes.
 */
const CACHE_VERSION = 2;

interface CacheEntry {
    version: number;
    /** Files included by the code, and hashes of their contents */
    dependencies: { file: string; hash: string }[];
    segments: { address: number; data: string }[];
    symbols: { [symbol: string]: number };
    list: string[];
    lines: ListingLine[];
}

/**
 * Cached code, shared by all Compilers in this process
 */
const memoryCache = new Map<string, CacheEntry>();

/**
 * Entries in the cache directory which haven't been used for this long are
 * deleted.
 */
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/**
 * Cache directories which have been pruned by this process
 */
const prunedCacheDirs = new Set<string>();

/**
 * The results of assembling some code, and the files it depends on, or
 * undefined if they aren't known, in which case it isn't cached.
 */
interface Assembled {
    prog: CompiledProg;
    dependencies: string[] | undefined;
}

export class Compiler {
    public readonly assembler: Assembler;
    private z80asm: string;
    private tmpDir: string;
    private args: string[];
    private cache: boolean;

    public constructor(options: CompilerOptions = {}) {
        const assembler =
            options.assembler || process.env.ZAT_ASSEMBLER || 'maz';
        if (!ASSEMBLERS.includes(assembler)) {
            throw new Error(
                `Unknown assembler '${assembler}': it must be maz or z80asm`
            );
        }
        this.assembler = assembler as Assembler;
        this.z80asm =
            options.z80asm || process.env.ZAT_Z80ASM || 'z88dk.z88dk-z80asm';
        this.tmpDir =
            options.tmpDir ||
            process.env.ZAT_TMPDIR ||
            path.join(process.cwd(), 'node_modules', '.cache', 'zat');
        this.args = options.args || [];
        this.cache = options.cache ?? process.env.ZAT_CACHE !== '0';
    }

    /**
     * Empty the in-memory cache. The cache directory is left alone.
     */
    public static clearMemoryCache() {
        memoryCache.clear();
    }

    /**
     * Compile some code. includeDir is used to find any included files, and
     * defaults to the current directory. name is used in error messages and
     * the listing.
     *
     * The result is cached, unless caching is turned off. A cached result is
     * only used if the code, options, and any included files are the same.
     */
    public compile(
        code: string,
        includeDir = process.cwd(),
        name = 'code'
    ): CompiledProg {
        if (!this.cache) {
            return this.assemble(code, includeDir, name).prog;
        }
        const key = createHash('sha256')
            .update(
                JSON.stringify([
                    CACHE_VERSION,
                    this.assembler,
                    ...(this.assembler === 'maz'
                        ? [mazVersion()]
                        : [this.z80asm, this.args]),
                    process.cwd(),
                    path.resolve(includeDir),
                    name,
                    code,
                ])
            )
            .digest('hex');
        const cached = this.readCache(key);
        if (cached) {
            return cached;
        }
        const { prog, dependencies } = this.assemble(code, includeDir, name);
        if (dependencies) {
            this.writeCache(key, prog, dependencies);
        }
        return prog;
    }

    private cacheFile(key: string) {
        return path.join(this.tmpDir, 'cache', `${key}.json`);
    }

    private readCache(key: string): CompiledProg | undefined {
        let entry = memoryCache.get(key);
        if (!entry) {
            const file = this.cacheFile(key);
            try {
                entry = JSON.parse(
                    fs.readFileSync(file).toString()
                ) as CacheEntry;
                // Record when the entry was last used, for pruneCache
                const now = new Date();
                fs.utimesSync(file, now, now);
            } catch {
                return undefined;
            }
        }
        if (
            entry.version !== CACHE_VERSION ||
            entry.dependencies.some(({ file, hash }) => hashFile(file) !== hash)
        ) {
            memoryCache.delete(key);
            return undefined;
        }
        memoryCache.set(key, entry);
        const segments = entry.segments.map(({ address, data }) => ({
            address,
            data: Buffer.from(data, 'base64'),
        }));
        const [data, origin] = combineSegments(segments);
        return new CompiledProg(
            data,
            origin,
            segments,
            { ...entry.symbols },
            [...entry.list],
            entry.lines.map((line) => ({ ...line }))
        );
    }

    private writeCache(key: string, prog: CompiledProg, files: string[]) {
        const dependencies = [];
        for (const file of files) {
            const hash = hashFile(file);
            if (hash === undefined) {
                return;
            }
            dependencies.push({ file, hash });
        }
        const entry: CacheEntry = {
            version: CACHE_VERSION,
            dependencies,
            segments: prog.segments.map(({ address, data }) => ({
                address,
                data: data.toString('base64'),
            })),
            symbols: { ...prog.symbols },
            list: [...prog.list],
            lines: prog.lines.map((line) => ({ ...line })),
        };
        memoryCache.set(key, entry);
        // Failing to write to the cache directory isn't an error. Write to
        // a temporary file first, as other processes may read the cache.
        try {
            const file = this.cacheFile(key);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmpFile = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(entry));
            fs.renameSync(tmpFile, file);
            this.pruneCache();
        } catch {}
    }

    /**
     * Delete entries in the cache directory which haven't been used for a
     * while. This is done once per process.
     */
    private pruneCache() {
        const dir = path.join(this.tmpDir, 'cache');
        if (prunedCacheDirs.has(dir)) {
            return;
        }
        prunedCacheDirs.add(dir);
        const oldest = Date.now() - CACHE_MAX_AGE;
        for (const file of fs.readdirSync(dir)) {
            try {
                const filePath = path.join(dir, file);
                if (fs.statSync(filePath).mtimeMs < oldest) {
                    fs.rmSync(filePath);
                }
            } catch {}
        }
    }

    private assemble(
        code: string,
        includeDir: string,
        name: string
    ): Assembled {
        return this.assembler === 'maz'
            ? this.assembleWithMaz(code, includeDir, name)
            : this.assembleWithZ80asm(code, includeDir, name);
    }

    private assembleWithMaz(
        code: string,
        includeDir: string,
        name: string
    ): Assembled {
        const fileResolver = new MazFileResolver(
            name,
            code,
            path.resolve(includeDir)
        );
        let programme: Programme;
        try {
            programme = mazCompile(name, { fileResolver, quiet: true });
        } catch (e) {
            throw new Error(
                `maz failed: ${e instanceof Error ? e.message : String(e)}`
            );
        }
        if (programme.errors.length > 0) {
            throw new Error(
                `maz failed:\n${programme.errors
                    .map((error) =>
                        error.location
                            ? `${error.filename ?? name}:${error.location.line}: ${error.error}`
                            : error.error
                    )
                    .join('\n')}`
            );
        }
        const segments = programme.getSegments().map(({ address, bytes }) => ({
            address,
            data: Buffer.from(bytes),
        }));
        const symbols: { [symbol: string]: number } = {};
        for (const [symbol, value] of Object.entries(programme.symbols)) {
            if (typeof value === 'number') {
                symbols[symbol] = value;
            }
        }
        const lines = programme
            .getLines()
            .map(({ file, line, address, length, source, data }) => ({
                file,
                line,
                address,
                length,
                source,
                data,
            }));
        const [data, origin] = combineSegments(segments);
        return {
            prog: new CompiledProg(
                data,
                origin,
                segments,
                symbols,
                programme.getList(false),
                lines
            ),
            dependencies: [...fileResolver.dependencies],
        };
    }

    private assembleWithZ80asm(
        code: string,
        includeDir: string,
        name: string
    ): Assembled {
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
            const runZ80asm = () => {
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
                    const error = e as Error & {
                        stderr?: Buffer;
                        stdout?: Buffer;
                    };
                    const output = `${error.stderr || ''}${
                        error.stdout || ''
                    }`.trim();
                    throw new Error(
                        `z80asm failed: ${output || error.message}`.replace(
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

            let { map, list } = runZ80asm();
            // The listing also has the lines of any included files. If they
            // have constants which are missing, assemble again.
            const missing = findConstants(listingSource(list)).filter(
                (constant) => !(constant in map.symbols)
            );
            if (missing.length > 0) {
                fs.writeFileSync(
                    asmFile,
                    makePublic(code, [...constants, ...missing])
                );
                ({ map, list } = runZ80asm());
            }

            const segments = readSegments(dir, base, map.heads);
            const lines = parseListing(list, map.heads);
            const [data, origin] = combineSegments(segments);
            return {
                prog: new CompiledProg(
                    data,
                    origin,
                    segments,
                    map.symbols,
                    list,
                    lines
                ),
                dependencies: findDependencies(list, includeDir, name),
            };
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

/**
 * Gives maz the code as the top level file, and reads included files from
 * disk, relative to the file which includes them, or to includeDir. It
 * records which files are read, so the cache knows the code depends on them.
 */
class MazFileResolver implements FileResolver {
    public readonly dependencies = new Set<string>();
    /** The files being read, innermost last */
    private files: { name: string; dir: string }[] = [];

    public constructor(
        private name: string,
        private code: string,
        private includeDir: string
    ) {}

    public get filename(): string | undefined {
        return this.files[this.files.length - 1]?.name;
    }

    public getRealFilename(filename: string): string {
        const dir = this.files[this.files.length - 1]?.dir ?? this.includeDir;
        const candidates = [
            path.resolve(dir, filename),
            path.resolve(this.includeDir, filename),
        ];
        return candidates.find(isFile) ?? candidates[0];
    }

    public fileExists(filename: string): boolean {
        return isFile(this.getRealFilename(filename));
    }

    public readFile(filename: string): string[] {
        if (this.files.length === 0) {
            this.files.push({ name: this.name, dir: this.includeDir });
            return this.code.split('\n');
        }
        const file = this.getRealFilename(filename);
        this.files.push({ name: file, dir: path.dirname(file) });
        this.dependencies.add(file);
        return fs.readFileSync(file).toString().split('\n');
    }

    public readBinaryFile(filename: string): number[] {
        const file = this.getRealFilename(filename);
        this.dependencies.add(file);
        return Array.from(fs.readFileSync(file));
    }

    public finishFile() {
        this.files.pop();
    }
}

function isFile(file: string) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

let cachedMazVersion: string | undefined;

/**
 * The version of maz, so the cache isn't used after maz is upgraded
 */
function mazVersion(): string {
    cachedMazVersion ??= (
        JSON.parse(
            fs.readFileSync(require.resolve('maz/package.json')).toString()
        ) as { version: string }
    ).version;
    return cachedMazVersion;
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
    const symbols: { [symbol: string]: number } = {};
    const heads: { [section: string]: number } = {};
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
            symbols[name] = value;
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
const DATA_DIRECTIVES = new Set([
    'db',
    'dw',
    'dp',
    'dq',
    'dm',
    'ds',
    'dc',
    'defb',
    'defw',
    'defp',
    'defq',
    'defm',
    'defs',
    'byte',
    'word',
    'binary',
    'incbin',
]);

/**
 * Whether a line of source code is a data directive, or uses a data macro.
 * Returns undefined if the line is empty, or only has a label.
 */
function isData(source: string, dataMacros: Set<string>): boolean | undefined {
    const words = source
        .replace(/;.*$/, '')
        .replace(/^\s*[.\w]+:/, '')
        .trim()
        .split(/[\s,]+/)
        .filter((word) => word !== '')
        .map((word) => word.toLowerCase().replace(/^\./, ''));
    if (words.length === 0) {
        return undefined;
    }
    return DATA_DIRECTIVES.has(words[0]) || dataMacros.has(words[0]);
}

/**
 * Find macros whose bodies only contain data directives.
 */
function findDataMacros(list: string[]): Set<string> {
    const dataMacros = new Set<string>();
    let macro: string | undefined;
    let allData = true;
    for (const source of listingSource(list)) {
        const start =
            /^\s*macro\s+(\w+)/i.exec(source) ??
            /^\s*(\w+):?\s+macro\b/i.exec(source);
        if (start) {
            macro = start[1].toLowerCase();
            allData = true;
        } else if (macro !== undefined && /^\s*endm\b/i.test(source)) {
            if (allData) {
                dataMacros.add(macro);
            }
            macro = undefined;
        } else if (macro !== undefined) {
            if (isData(source, dataMacros) === false) {
                allData = false;
            }
        }
    }
    return dataMacros;
}

function parseListing(
    list: string[],
    heads: { [section: string]: number }
): ListingLine[] {
    const dataMacros = findDataMacros(list);
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
            data: isData(source || '', dataMacros) ?? false,
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
        .map(
            (text) =>
                /^\s*\d+\s+(?:[0-9a-f]{4}\s+(?:[0-9a-f]{2})+\s+)?(.*)$/.exec(
                    text
                )?.[1]
        )
        .filter((source) => source !== undefined);
}

/**
 * Find the files which the code depends on: files included with include,
 * which are in the listing, and files included with binary or incbin. If a
 * binary file can't be found, return undefined.
 */
function findDependencies(
    list: string[],
    includeDir: string,
    name: string
): string[] | undefined {
    const files = new Set<string>();
    for (const text of list) {
        const match = /^(\S.*):$/.exec(text);
        if (match && match[1] !== name) {
            files.add(path.resolve(match[1]));
        }
    }
    for (const source of listingSource(list)) {
        const match = /^\s*(?:[.\w]+:?\s+)?(?:binary|incbin)\s+"([^"]+)"/i.exec(
            source
        );
        if (match) {
            const file = [
                path.resolve(match[1]),
                path.resolve(includeDir, match[1]),
            ].find((file) => fs.existsSync(file));
            if (!file) {
                return undefined;
            }
            files.add(file);
        }
    }
    return [...files];
}

function hashFile(file: string): string | undefined {
    try {
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch {
        return undefined;
    }
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
