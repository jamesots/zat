import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    Zat,
    getCoverage,
    saveCoverage,
    readSavedCoverage,
    formatLcov,
    writeLcov,
} from '../src/zat';

const file = path.resolve('spec/coverage.z80');

describe('coverage', function () {
    let zat: Zat;
    let dir: string;

    beforeEach(function () {
        // Start with no coverage from other tests
        getCoverage().clear();
        zat = new Zat();
        zat.defaultCallSp = 0xff00;
        fs.mkdirSync('node_modules/.cache', { recursive: true });
        dir = fs.mkdtempSync(path.resolve('node_modules/.cache/zat-test-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('should count executed lines', function () {
        zat.compileFile('spec/coverage.z80');
        expect(getCoverage()).toEqual(
            new Map([
                [
                    file,
                    new Map([
                        [3, 0],
                        [4, 0],
                        [5, 0],
                        [6, 0],
                        [8, 0],
                    ]),
                ],
            ])
        );

        zat.call('start');
        zat.call('start');
        expect(getCoverage().get(file)).toEqual(
            new Map([
                [3, 2],
                [4, 2],
                [5, 2],
                [6, 2],
                [8, 2],
            ])
        );
    });

    it('should count lines loaded at a different address', function () {
        zat.compileFile('spec/coverage.z80', 0x100);
        zat.call(0x100);
        expect(getCoverage().get(file)?.get(3)).toBe(1);
    });

    it('should stop counting lines which have been overwritten', function () {
        zat.compileFile('spec/coverage.z80');
        zat.load([0x3e, 0x05, 0xc9]);
        zat.call(0);
        expect(getCoverage().get(file)?.get(3)).toBe(0);
    });

    it('should not count code which is not from a file', function () {
        zat.compile('start:\n ld a,1\n ret\n');
        zat.call('start');
        expect(getCoverage().size).toBe(0);
    });

    it('should mark data lines', function () {
        const prog = zat.compile(`
macro data_macro x
    db x ; comment
    defw x
endm
macro code_macro x
    ld a,x
endm
start:
    ld a,1
    db 1
label: dw 2
    DEFM "hello"
    defs 2
    data_macro 4
    code_macro 5
    ret
        `);
        expect(prog.lines.map(({ line, data }) => [line, data])).toEqual([
            [10, false],
            [11, true],
            [12, true],
            [13, true],
            [14, true],
            [15, true],
            [16, false],
            [17, false],
        ]);
    });

    it('should save coverage and write an lcov file', function () {
        zat.compileFile('spec/coverage.z80');
        zat.call('start');
        saveCoverage(dir);
        expect(getCoverage().size).toBe(0);

        // Coverage saved separately, e.g. by different test files, is added
        // together
        zat = new Zat();
        zat.defaultCallSp = 0xff00;
        zat.compileFile('spec/coverage.z80');
        zat.call('start');
        saveCoverage(dir);
        expect(fs.readdirSync(dir).length).toBe(2);

        const lcov = `TN:
SF:${file}
DA:3,2
DA:4,2
DA:5,2
DA:6,2
DA:8,2
LF:5
LH:5
end_of_record
`;
        expect(formatLcov(readSavedCoverage(dir))).toBe(lcov);
        const lcovFile = path.join(dir, 'lcov', 'lcov.info');
        writeLcov(lcovFile, dir);
        expect(fs.readFileSync(lcovFile).toString()).toBe(lcov);
    });
});
