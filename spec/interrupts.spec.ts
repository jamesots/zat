import { describe, it, expect, beforeEach } from 'vitest';
import { Zat } from '../src/zat';

describe('interrupts', function () {
    let zat: Zat;

    beforeEach(function () {
        zat = new Zat();
        zat.defaultCallSp = 0xff00;
    });

    it('should raise interrupts regularly', function () {
        zat.compile(`
    section int
    org $38
    push af
    ld a,(frames)
    inc a
    ld (frames),a
    pop af
    ei
    reti

    section main
    org $100
start:
    im 1
    ei
wait:
    ld a,(frames)
    cp 5
    jr nz,wait
    ret
frames:
    db 0
        `);
        const { interrupts, tStates } = zat.call('start', {
            interruptEvery: 1000,
        });
        expect(zat.getMemory('frames', 1)).toEqual([5]);
        expect(interrupts).toBe(5);
        // The last interrupt is at 5000 T-states, and then the handler
        // and the rest of the loop run
        expect(tStates).toBeGreaterThan(5000);
        expect(tStates).toBeLessThan(5200);
    });

    it('should wait for an interrupt after a HALT', function () {
        zat.compile(`
    section int
    org $38
    ld b,$42
    ei
    ret

    section main
    org $100
start:
    im 1
    ei
    halt
    ld a,b
    ret
        `);
        const { interrupts, tStates } = zat.call('start', {
            interruptEvery: 1000,
        });
        expect(zat.z80.regs.a).toBe(0x42);
        expect(interrupts).toBe(1);
        expect(tStates).toBeGreaterThan(1000);
        expect(tStates).toBeLessThan(1100);
    });

    it('should stop at a HALT if interrupts are disabled', function () {
        zat.compile(`
start:
    di
    halt
        `);
        const { interrupts, tStates } = zat.run('start', {
            interruptEvery: 1000,
        });
        expect(zat.z80.regs.halted).toBe(1);
        expect(interrupts).toBe(0);
        expect(tStates).toBe(8);
    });

    it('should miss interrupts while interrupts are disabled', function () {
        zat.compile(`
    section int
    org $38
    inc c
    ei
    ret

    section main
    org $100
start:
    im 1
    di
    ld c,0
    ld b,100
loop:
    djnz loop ; 13 T-states each time, 8 the last time
    ret
        `);
        const { interrupts } = zat.call('start', { interruptEvery: 100 });
        expect(interrupts).toBe(0);
        expect(zat.z80.regs.c).toBe(0);
    });

    it('should accept an interrupt after the instruction after EI', function () {
        zat.compile(`
    section int
    org $38
    ld (seen),a
    ret

    section main
    org $100
start:
    im 1 ; 8 T-states
    ei ; 4 T-states
    ld a,1
    ld a,2
    halt
seen:
    db $ff
        `);
        // The interrupt is due straight after EI
        const { interrupts } = zat.run('start', { interruptEvery: 12 });
        expect(interrupts).toBe(1);
        expect(zat.getMemory('seen', 1)).toEqual([1]);
    });

    it('should raise non-maskable interrupts', function () {
        zat.compile(`
    section nmi
    org $66
    inc c
    retn

    section main
    org $100
start:
    di
    ld c,0
wait:
    ld a,c
    cp 3
    jr nz,wait
    ret
        `);
        const { interrupts } = zat.call('start', {
            interruptEvery: 500,
            interruptNonMaskable: true,
        });
        expect(interrupts).toBe(3);
        expect(zat.z80.regs.c).toBe(3);
    });

    it('should let an interrupt handler be mocked', function () {
        zat.compile(`
    section int
    org $38
int:
    ret

    section main
    org $100
start:
    im 1
    ei
    halt
    ret
        `);
        let count = 0;
        zat.mockCall('int', () => {
            count++;
            zat.z80.regs.iff1 = 1;
        });
        zat.call('start', { interruptEvery: 1000 });
        expect(count).toBe(1);
    });

    it('should reject interruptEvery of 0', function () {
        zat.compile(' ret\n');
        expect(() => zat.run(0, { interruptEvery: 0 })).toThrow(
            'interruptEvery must be more than 0'
        );
    });
});
