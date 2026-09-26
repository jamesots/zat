import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    vi,
    MockInstance,
} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Compiler, CompilerOptions } from '../src/zat';
import { assemblers, skipAssembler } from './assemblers';

describe.each(assemblers)('Compiler cache with %s', function (assembler) {
    let dir: string;
    let options: CompilerOptions;
    let assemble: MockInstance;
    const include = assembler === 'maz' ? '.include' : 'include';
    const binary = assembler === 'maz' ? '.incbin' : 'binary';

    beforeEach(function (context) {
        if (skipAssembler(assembler)) {
            context.skip('z80asm is not installed');
        }
        // Not in the scratch directory, as the snap version of z80asm can't
        // see /tmp
        fs.mkdirSync('node_modules/.cache', { recursive: true });
        dir = fs.mkdtempSync(path.resolve('node_modules/.cache/zat-test-'));
        options = { assembler, tmpDir: path.join(dir, 'tmp') };
        // Count how many times the code is assembled
        assemble = vi.spyOn(
            Compiler.prototype as unknown as { assemble: () => unknown },
            'assemble'
        );
        Compiler.clearMemoryCache();
    });

    afterEach(function () {
        vi.restoreAllMocks();
        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function assembleCount() {
        return assemble.mock.calls.length;
    }

    it('should use the in-memory cache', function () {
        const compiler = new Compiler(options);
        const prog1 = compiler.compile('start:\n ld a,1\n ret\n');
        const prog2 = compiler.compile('start:\n ld a,1\n ret\n');
        expect(assembleCount()).toBe(1);
        expect(prog2).toEqual(prog1);

        // Each result is a separate copy
        prog1.data[0] = 0;
        prog1.symbols.start = 5;
        expect(compiler.compile('start:\n ld a,1\n ret\n')).toEqual(prog2);
    });

    it('should use the cache directory', function () {
        const prog1 = new Compiler(options).compile('start:\n ld a,1\n ret\n');
        Compiler.clearMemoryCache();
        const prog2 = new Compiler(options).compile('start:\n ld a,1\n ret\n');
        expect(assembleCount()).toBe(1);
        expect(prog2).toEqual(prog1);
    });

    it('should assemble different code', function () {
        const compiler = new Compiler(options);
        compiler.compile('start:\n ld a,1\n ret\n');
        const prog = compiler.compile('start:\n ld a,2\n ret\n');
        expect(assembleCount()).toBe(2);
        expect(prog.data).toEqual(Buffer.from([0x3e, 0x02, 0xc9]));
    });

    it('should assemble again if an included file changes', function () {
        const compiler = new Compiler(options);
        const file = path.join(dir, 'include.asm');
        const code = `${include} "${file}"\nstart:\n ld a,value\n ret\n`;
        fs.writeFileSync(file, 'value: equ 1\n');
        compiler.compile(code);
        compiler.compile(code);
        expect(assembleCount()).toBe(1);

        fs.writeFileSync(file, 'value: equ 2\n');
        let prog = compiler.compile(code);
        expect(assembleCount()).toBe(2);
        expect(prog.data).toEqual(Buffer.from([0x3e, 0x02, 0xc9]));

        Compiler.clearMemoryCache();
        fs.writeFileSync(file, 'value: equ 3\n');
        prog = compiler.compile(code);
        expect(assembleCount()).toBe(3);
        expect(prog.data).toEqual(Buffer.from([0x3e, 0x03, 0xc9]));
    });

    it('should assemble again if a binary file changes', function () {
        const compiler = new Compiler(options);
        const file = path.join(dir, 'data.bin');
        const code = `start:\n ${binary} "${file}"\n`;
        fs.writeFileSync(file, Buffer.from([1, 2]));
        compiler.compile(code);
        compiler.compile(code);
        expect(assembleCount()).toBe(1);

        fs.writeFileSync(file, Buffer.from([3, 4]));
        const prog = compiler.compile(code);
        expect(assembleCount()).toBe(2);
        expect(prog.data).toEqual(Buffer.from([3, 4]));
    });

    it('should delete entries which have not been used for 30 days', function () {
        const cacheDir = path.join(dir, 'tmp', 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const old = path.join(cacheDir, 'old.json');
        const recent = path.join(cacheDir, 'recent.json');
        fs.writeFileSync(old, '{}');
        fs.writeFileSync(recent, '{}');
        const days = (n: number) => new Date(Date.now() - n * 86400000);
        fs.utimesSync(old, days(31), days(31));
        fs.utimesSync(recent, days(29), days(29));

        new Compiler(options).compile('start:\n ret\n');
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(recent)).toBe(true);
    });

    it('should not cache errors', function () {
        const compiler = new Compiler(options);
        expect(() => compiler.compile(' bad\n')).toThrow();
        expect(() => compiler.compile(' bad\n')).toThrow();
        expect(assembleCount()).toBe(2);
    });

    it('should not cache if caching is turned off', function () {
        const compiler = new Compiler({ ...options, cache: false });
        compiler.compile('start:\n ld a,1\n ret\n');
        compiler.compile('start:\n ld a,1\n ret\n');
        expect(assembleCount()).toBe(2);
        expect(fs.existsSync(path.join(dir, 'tmp', 'cache'))).toBe(false);
    });
});
