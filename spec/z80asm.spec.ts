import { describe, it, expect, beforeEach } from 'vitest';
import { Zat, Compiler } from '../src/zat';
import { z80asmInstalled } from './assemblers';

// Tests of things which are particular to z80asm. The other tests use maz,
// but most of them would work with either.
describe.skipIf(!z80asmInstalled)('z80asm', function () {
    let zat: Zat;

    beforeEach(function () {
        zat = new Zat({ assembler: 'z80asm' });
        zat.defaultCallSp = 0xff00;
    });

    it('should work with a compiled file', function () {
        zat.compileFile('spec/z80asm/test.z80');
        zat.setBreakpoint('breakhere');
        zat.run('newstart');
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(1);
    });

    it('should put sections at their own addresses', function () {
        const prog = zat.compile(`
    jp start
    section int
    org $38
int:
    ret
    section main
    org $100
start:
    ld a,5
    ret
        `);
        expect(prog.segments.map(({ address }) => address)).toEqual([
            0, 0x38, 0x100,
        ]);
        expect(zat.getAddress('int')).toBe(0x38);
        zat.call('start');
        expect(zat.z80.regs.a).toBe(5);
    });

    it('should include unused constants in the symbols', function () {
        const prog = zat.compile(`
equ_const: equ $10
.dot_const equ $11
eq_const = $12
defc defc1 = $13, defc2 = $14 ; comment = 1
if 0
false_const: equ $15
endif
include "spec/constants.inc"
used_const: equ 1
start:
    ld a,used_const
    ret
        `);
        expect(zat.symbols).toEqual({
            equ_const: 0x10,
            dot_const: 0x11,
            eq_const: 0x12,
            defc1: 0x13,
            defc2: 0x14,
            inc_const: 0x33,
            used_const: 1,
            start: 0,
        });
        expect(prog.data).toEqual(Buffer.from([0x3e, 0x01, 0xc9]));
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

    it('should throw assembler errors', function () {
        expect(() => zat.compile(' ld a,1\n bad\n')).toThrow(
            /^z80asm failed: code:2: error: syntax error/
        );
    });
});

describe('assembler option', function () {
    it('should use maz by default', function () {
        expect(new Compiler().assembler).toBe('maz');
        expect(new Zat().compiler.assembler).toBe('maz');
    });

    it('should reject an unknown assembler', function () {
        expect(() => new Compiler({ assembler: 'pasmo' as 'maz' })).toThrow(
            "Unknown assembler 'pasmo': it must be maz or z80asm"
        );
    });
});
