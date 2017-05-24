import { Z80 } from '../src/z80/Z80';
import { Zat, stringToBytes, hex16 } from '../src/zat';

describe('things', function() {
    let zat: Zat;

    beforeEach(function() {
        zat = new Zat();
        zat.memRead = (addr) => {
            // console.log(`read ${hex16(addr)}`);
            return undefined;
        }
        zat.ioWrite = (port, value) => {
            console.log(`OUT ${hex16(port)}, ${hex16(value)}`);
        }
        zat.ioRead = (port) => {
            console.log(`IN ${hex16(port)}`);
            return 0x00;
        }
    });

    it('should work with a compiled file', function() {
        zat.compileFile('spec/test.z80');
        zat.run('newstart', {breakAt:'breakhere'});
        expect(zat.z80.a).toBe(0x12);
        expect(zat.z80.flags.Z).toBe(1);
    });

    it('should work with a compiled string', function() {
        zat.compile(`
start:
    ld a,0
    halt
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
        zat.run('newstart', {breakAt:'breakhere'});
        expect(zat.z80.a).toBe(0x12);
        expect(zat.z80.flags.Z).toBe(1);
    });

    it('should work with loading data', function() {
        zat.load([0x3e, 0x00, 0x76, 0x00, 0x00, 0x00, 0x00, 0x00,
                  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                  0x00, 0x00, 0x00, 0x00, 0xb7, 0x3e, 0x12, 0x00,
                  0x00, 0x00, 0x3e, 0x13, 0x00, 0xc3, 0x14, 0x00]);
        zat.run(20, {breakAt:26});
        expect(zat.z80.a).toBe(0x12);
        expect(zat.z80.flags.Z).toBe(1);
    });

    it('should use onStep to stop', function() {
        zat.compileFile('spec/test.z80');
        zat.onStep = (pc) => pc === zat.getAddress('breakhere');
        zat.run('newstart');
        expect(zat.z80.a).toBe(0x12);
        expect(zat.z80.flags.Z).toBe(1);

        // zat.whenIoRead(8).return('hello\r');
        // zat.whenIoRead(9).return(0).always();
        // expect(zat.memoryAt('line', 10)).toBe('hello\0');
    });

    it('should work with a compiled file and compiled string', function() {
        zat.compileFile('spec/test.z80');
        zat.compile(`
    org 40
extrastart:
    jp ${zat.getAddress('newstart')}
        `, 40);
        zat.run('extrastart', {breakAt:'breakhere'});
        expect(zat.z80.a).toBe(0x12);
        expect(zat.z80.flags.Z).toBe(1);
    });


    it('should read a line', function() {
        zat.compileFile('spec/test.z80');

        const bytes = [];
        zat.ioWrite = (port, value) => {
            expect(port & 0xff).toBe(8);
            bytes.push(value);
        }
        zat.ioRead = (port) => {
            expect(port & 0xff).toBe(9);
            return 0x00;
        }
        zat.load(stringToBytes('Hello\0'), 0x5000);
        zat.z80.hl = 0x5000;
        zat.z80.sp = 0xFF00;
        zat.run('write_line', {call: true});
        expect(bytes).toEqual(stringToBytes('Hello'));
    });
});