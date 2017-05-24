import { Z80 } from '../src/z80/Z80';
import { Zat } from '../src/zat';

describe('things', function() {
    let zat: Zat;

    beforeEach(function() {
        zat = new Zat();
        zat.memRead = (addr) => {
            // console.log(`read ${addr}`);
            return undefined;
        }
        zat.ioWrite = (port, value) => {
            console.log(`OUT ${port.toString(16)}, ${value.toString(16)}`);
        }
        zat.ioRead = (port) => {
            console.log(`IN ${port.toString(16)}`);
            return 0x00;
        }
    });

    it('should work', function() {
        // zat.load([0x3e, 0x12, 0xd3, 0x56, 0x76]);
        // zat.compile(`
        // ld a,0
        // halt
        // org 20
        // ld a,$12
        // halt
        // `)
        // zat.whenIoRead(8).return('hello\r');
        // zat.whenIoRead(9).return(0).always();
        zat.compileFile('spec/test.z80');
        // zat.onStep = (pc) => pc === 20;
        zat.run('newstart', {breakAt:'breakhere'});
        expect(zat.registers.a).toBe(0x12);
        expect(zat.registers.flags.Z).toBe(1);
        // expect(zat.memoryAt('line', 10)).toBe('hello\0');
    });

    // it('should do stuff', function() {
    //     zat.compileFile('../z80/tinymonitor.z80');
    //     zat.compile(`
    //     ld hl,msg
    //     call ${zat.symbols['WRITE_LINE']}
    //     halt
    //     msg: db 'Hello$'
    //     db 0
    //     `);
    //     zat.run(0);
    // });
});