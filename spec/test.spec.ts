import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
    Zat,
    IoSpy,
    IoSpyError,
    StepResponse,
    customMatchers,
    stringToBytes,
    hex16,
    Compiler,
    CompiledProg,
    Z80,
} from '../src/zat';

expect.extend(customMatchers);

describe('things', function () {
    let zat: Zat;
    let prog: CompiledProg;

    beforeAll(function () {
        prog = new Compiler().compileFile('spec/test.z80');
    });

    beforeEach(function () {
        zat = new Zat();
        zat.defaultCallSp = 0xff00;
    });

    it('should work with a compiled file', function () {
        zat.loadProg(prog);
        zat.setBreakpoint('breakhere');
        zat.run('newstart');
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(1);
    });

    it('should work with a compiled string', function () {
        zat.compile(`
start:
    ld a,0
    halt
    section main
    org 20
newstart:
    or a
    ld a,$12
    nop
    nop
    nop
breakhere:
    ld a,$13
    nop
    jp newstart
        `);
        zat.setBreakpoint('breakhere');
        zat.run('newstart');
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(1);
    });

    it('should work with loading data', function () {
        zat.load([
            0x3e, 0x00, 0x76, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb7, 0x3e,
            0x12, 0x00, 0x00, 0x00, 0x3e, 0x13, 0x00, 0xc3, 0x14, 0x00,
        ]);
        zat.setBreakpoint(26);
        zat.run(20);
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(1);
    });

    it('should use onStep to stop', function () {
        zat.loadProg(prog);
        zat.setBreakpoint('breakhere');
        zat.run('newstart');
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(1);

        // expect(zat.memoryAt('line', 10)).toBe('hello\0');
    });

    it('should work with a compiled file and compiled string', function () {
        zat.loadProg(prog);
        zat.compile(
            `
    org 40
extrastart:
    jp ${zat.getAddress('newstart')}
        `,
            40
        );
        zat.setBreakpoint('breakhere');
        zat.run('extrastart');
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(1);
    });

    it('should write a line', function () {
        zat.loadProg(prog);

        zat.load('Hello\0', 0x5000);
        let ioSpy = new IoSpy(zat)
            .onIn(9, 0)
            .onOut(8, 'H')
            .onIn(9, 0)
            .onOut(8, 'e')
            .onIn(9, 0)
            .onOut(8, 'l')
            .onIn(9, 0)
            .onOut(8, 'l')
            .onIn(9, 0)
            .onOut(8, 'o');
        zat.onIoWrite = ioSpy.writeSpy();
        zat.onIoRead = ioSpy.readSpy();
        zat.z80.regs.hl = 0x5000;
        zat.call('write_line');
        expect(ioSpy).toBeComplete();
    });

    it('should read a character', function () {
        zat.loadProg(prog);

        let ioSpy = new IoSpy(zat).onIn([9, '\xff\xff\0'], [8, 65]);
        zat.onIoRead = ioSpy.readSpy();
        zat.call('read_char');
        expect(zat.z80.regs.a).toEqual(65);
        expect(ioSpy).toBeComplete();
    });

    it('should sound bell', function () {
        zat.loadProg(prog);

        const values: [number, number][] = [];
        let count = 0;
        zat.onMemRead = (addr) => {
            if (addr == zat.getAddress('sound_bell1')) {
                count++;
            }
            return undefined;
        };
        zat.onIoWrite = (port, value) => {
            values.push([port & 0xff, value]);
        };
        zat.call('sound_bell');
        expect(values).toEqual([
            [6, 0xff],
            [6, 0],
        ]);
        expect(count).toEqual(0x100 * 0x10 - 1);
    });

    it('should throw if IO is not as expected', function () {
        zat.compile(`
ft245: equ 8
start:
    ld a,1
    out (5),a
    ld a,2
    out (6),a
    ret
        `);
        let ioSpy = new IoSpy(zat).onOut([5, 1], [6, 3]);
        zat.onIoWrite = ioSpy.writeSpy();
        expect(() => zat.call('start')).toThrow(
            new IoSpyError('Expected OUT to port 06 of 03 but got 02')
        );

        ioSpy = new IoSpy(zat).onOut(5, 1);
        zat.onIoWrite = ioSpy.writeSpy();
        expect(() => zat.call('start')).toThrow(
            'Unexpected OUT to port 06 of 02: all the expected IO has happened'
        );

        ioSpy = new IoSpy(zat).onOut([5, 1], ['ft245', 2]);
        zat.onIoWrite = ioSpy.writeSpy();
        expect(() => zat.call('start')).toThrow(
            'Expected OUT to port 08 (ft245) but got port 06'
        );
    });

    it('should have case-sensitive symbols', function () {
        zat.compile(`
Foo:
    nop
foo:
    ret
        `);
        expect(zat.getAddress('Foo')).toBe(0);
        expect(zat.getAddress('foo')).toBe(1);
        expect(() => zat.getAddress('FOO')).toThrow(
            new Error('Symbol "FOO" not found (did you mean "Foo"?)')
        );
        expect(() => zat.getAddress('bar')).toThrow(
            new Error('Symbol "bar" not found')
        );
    });

    it('should match 16-bit ports if the expected port is more than $FF', function () {
        zat.compile(`
keys: equ $fbfe
start:
    ld bc,keys
    in a,(c)
    ld b,$fd
    in a,(c)
    ret
        `);
        const ioSpy = new IoSpy(zat).onIn(['keys', 1], [0xfdfe, 2]);
        zat.onIoRead = ioSpy.readSpy();
        zat.call('start');
        expect(ioSpy).toBeComplete();

        zat.onIoRead = new IoSpy(zat).onIn([0xfbfe, 1], [0xfbfe, 2]).readSpy();
        expect(() => zat.call('start')).toThrow(
            'Expected IN from port fbfe but got port fdfe'
        );
    });

    it('should format memory', function () {
        zat.load('Hello, world!\0\x01\x7f', 0x1004);
        // Each byte is 3 characters in the hex, and 1 in the ASCII
        const blank = (bytes: number) => ' '.repeat(bytes * 3);
        expect(zat.formatMemory(0x1004, 8)).toBe(
            `1000 ${blank(4)}48 65 6c 6c 6f 2c 20 77 ${blank(4)}     Hello, w`
        );
        expect(zat.formatMemory(0x1004, 16)).toBe(
            `1000 ${blank(4)}48 65 6c 6c 6f 2c 20 77 6f 72 6c 64      Hello, world\n` +
                `1010 21 00 01 7f ${blank(12)} !···`
        );
        expect(zat.formatMemory(0x1000, 16)).toBe(
            '1000 00 00 00 00 48 65 6c 6c 6f 2c 20 77 6f 72 6c 64  ····Hello, world'
        );
        // Stops at the end of memory
        expect(zat.formatMemory(0xfffe, 4)).toBe(
            `fff0 ${blank(14)}00 00  ${' '.repeat(14)}··`
        );
        expect(zat.formatMemory(0x1000, 0)).toBe('');
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

    it('should read and write', function () {
        zat.compile(`
start:
    ld a,1
    out (5),a
    in a,(6)
    out (7),a
    in a,(8)
    ld a,100
    out (1),a
    out (2),a
    in a,(2)
    in a,(2)
    out (1),a
    ret
        `);
        const ioSpy = new IoSpy(zat)
            .onOut(5, 1)
            .onIn(6, 27)
            .onOut(7, 27)
            .onIn(8, 11)
            .onOut([1, 100], [2, 100])
            .onIn([2, 1], [2, 2])
            .onOut(1, 2);
        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('start');
        expect(ioSpy).toBeComplete();
    });

    it('should read a line', function () {
        zat.loadProg(prog);

        // Create two separate spies, so that the order of reads and writes doesn't matter.
        // It does, but I'm trying to test the bigger picture. Can do the order in another test.
        const readSpy = new IoSpy(zat)
            .onIn('ft245', '\x08heg\x08llo\r') // add some deletes in here
            .readSpy();
        const writeSpy = new IoSpy(zat)
            // the first delete should ring the bell, as the buffer is empty
            .onOut(['bell', [0xff, 0]], ['ft245', 'heg\x08llo\r'])
            .writeSpy();
        zat.onIoRead = (port) => {
            // If it's the ftdi_status port, always return 0 (ready)
            if ((port & 0xff) === zat.getAddress('ft245_status')) {
                return 0;
            }
            // ...otherwise use the spy
            return readSpy(port);
        };
        zat.onIoWrite = writeSpy;
        zat.call('read_line');
        expect(zat.getMemory('line', 6)).toEqual(stringToBytes('hello\0'));
    });

    it('should read a line - details', function () {
        zat.loadProg(prog);

        const ioSpy = new IoSpy(zat)
            .onIn(['ft245_status', 0], ['ft245', 8]) // read a backspace
            .onOut(['bell', [0xff, 0]]) // sound bell
            .onIn(['ft245_status', 0], ['ft245', 'h'], ['ft245_status', 0]) // read 'h', check we can write
            .onOut(['ft245', 'h']) // write 'h'
            .onIn(['ft245_status', 0], ['ft245', '\r'], ['ft245_status', 0]) // read CR, check we can write
            .onOut(['ft245', '\r']); // write CR

        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('read_line');
        expect(zat.getMemory('line', 2)).toEqual(stringToBytes('h\0'));
    });

    it('should find first string', function () {
        zat.loadProg(prog);

        zat.load('LET\0', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('let'));
    });

    it('should find second string', function () {
        zat.loadProg(prog);

        zat.load('TIME\0', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('time'));
    });

    it('should find second string, terminated by space', function () {
        zat.loadProg(prog);

        zat.load('TIME ', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('time'));
    });

    it('should fail to find string', function () {
        zat.loadProg(prog);

        zat.load('WIBBLE\0', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('error'));
    });

    it('should fail to find short string', function () {
        zat.loadProg(prog);

        zat.load('LE ', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('error'));
    });

    it('should fail to find no string', function () {
        zat.loadProg(prog);

        zat.load(' ', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('error'));
    });

    it('should fail to find incomplete string', function () {
        zat.loadProg(prog);

        // zat.onStep = (pc) => {
        //     console.log(`${zat.formatBriefRegisters()} ${zat.getSymbol(pc)}`);
        //     return false;
        // }
        zat.load('LETTER\0', 'line');
        zat.z80.regs.hl = zat.getAddress('line');
        zat.call('compare');

        expect(zat.z80.regs.de).toBe(zat.getAddress('error'));
        // zat.dumpMemory(0, 0x300);
    });

    it('should mock a call', function () {
        zat.compile(`
start:
    ld a,5
    call subroutine
    add a,1
    halt
subroutine:
    ret
        `);

        zat.run('start');
        expect(zat.z80.regs.a).toBe(6);

        zat.mockCall('subroutine', () => {
            zat.z80.regs.a += 10;
            return StepResponse.RUN;
        });
        zat.run('start');
        expect(zat.z80.regs.a).toBe(16);
    });

    it('should push a return address for call', function () {
        zat.compile(`
start:
    pop hl
    push hl
    ret
        `);
        const { instructions } = zat.call('start', { returnAddress: 0x1234 });
        expect(instructions).toBe(3);
        expect(zat.z80.regs.hl).toBe(0x1234);
        expect(zat.z80.regs.pc).toBe(0x1234);
        expect(zat.z80.regs.sp).toBe(0xff00);
        expect(zat.getMemory(0xfefe, 2)).toEqual([0x34, 0x12]);

        zat.call('start', { returnAddress: 'start', sp: 0x8000 });
        expect(zat.z80.regs.hl).toBe(zat.getAddress('start'));
        expect(zat.z80.regs.pc).toBe(zat.getAddress('start'));
        expect(zat.z80.regs.sp).toBe(0x8000);
    });

    it('should not intercept a call if there is no call statement', function () {
        zat.compile(`
start:
    ld a,5
subroutine:
    add a,1
    ret
        `);

        zat.mockCall('subroutine', () => {
            zat.z80.regs.a += 10;
        });
        zat.call('start');
        expect(zat.z80.regs.a).toBe(6);
    });

    it('should not intercept a call if a conditional call is not taken', function () {
        zat.compile(`
start:
    ld a,5
    or a
    call z,subroutine
subroutine:
    add a,1
    ret
        `);

        zat.mockCall('subroutine', () => {
            zat.z80.regs.a += 10;
        });
        zat.call('start');
        expect(zat.z80.regs.a).toBe(6);
    });

    it('should intercept an RST', function () {
        zat.compile(`
    jp start
    section rst8
    org $08
rst8:
    ret
    section main
    org $100
start:
    ld a,5
    rst 8
    halt
        `);

        zat.mockCall('rst8', () => {
            zat.z80.regs.a += 10;
        });
        zat.run('start');
        expect(zat.z80.regs.a).toBe(15);
    });

    it('should continue after a HALT', function () {
        zat.compile(`
start:
    ld a,1
    halt
    ld a,2
    halt
        `);

        zat.run('start');
        expect(zat.z80.regs.a).toBe(1);
        expect(zat.z80.regs.pc).toBe(2);
        zat.run();
        expect(zat.z80.regs.a).toBe(2);
    });

    it('should get and set flags', function () {
        zat.z80.regs.f = 0;
        zat.flags.Z = 1;
        zat.flags.C = true;
        expect(zat.z80.regs.f).toBe(0x41);
        expect(zat.flags.Z).toBe(1);
        expect(zat.flags.S).toBe(0);
        expect(`${zat.flags}`).toBe('.Z.....C');
        zat.flags.Z = 0;
        expect(zat.z80.regs.f).toBe(0x01);
        zat.altFlags.S = 1;
        expect(zat.z80.regs.afPrime).toBe(0x0080);
    });

    it('should handle an interrupt', function () {
        zat.compile(`
    jp start
    section int
    org $38
    ld b,$42
    ei
    ret
    section main
    org $100
start:
    ld sp,$ff00
    im 1
    ei
    halt
    ld a,b
    halt
        `);

        zat.run('start');
        zat.interrupt();
        zat.run();
        expect(zat.z80.regs.a).toBe(0x42);
    });

    it('should count T-states', function () {
        zat.compile(`
start:
    ld a,5
    add a,(ix+0)
    halt
        `);
        const { instructions, tStates } = zat.run('start');
        expect(instructions).toBe(3);
        expect(tStates).toBe(7 + 19 + 4);
    });

    it('should show coverage', function () {
        let prog = zat.compile(`
start:
    ld a,5
    call subroutine
    halt
    out (2),a
subroutine:
    add a,1
    ret
        `);

        const { coverage } = zat.run('start');
        expect(zat.z80.regs.a).toBe(6);
        zat.showCoverage(prog, coverage);
    });
});
