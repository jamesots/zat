import { Z80 } from '../src/z80/Z80';
import { Zat } from '../src/z80test';

describe('things', function() {
    let zat: Zat;

    beforeEach(function() {
        zat = new Zat();
        zat.memRead = (addr) => {
            // console.log(`read ${addr}`);
            return undefined;
        }
    });

    it('should work', function() {
        // zat.load([0x3e, 0x12, 0xd3, 0x56, 0x76]);
        zat.compile(`
        ld a,0
        halt
        org 20
        ld a,$12
        halt
        `)
        zat.run(20);
        expect(zat.registers.a).toBe(0x12);
    })
});