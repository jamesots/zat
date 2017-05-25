import { Z80 } from '../src/z80/Z80';
import { Zat, IoSpy, customMatchers, stringToBytes, hex16 } from '../src/zat';

describe('things', function() {
    let zat: Zat;

    beforeEach(function() {
        jasmine.addMatchers(customMatchers as any);

        zat = new Zat();
        zat.onMemRead = (addr) => {
            // console.log(`read ${hex16(addr)}`);
            return undefined;
        }
        zat.onIoWrite = (port, value) => {
            console.log(`OUT ${hex16(port)}, ${hex16(value)}`);
        }
        zat.onIoRead = (port) => {
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

    it('should write a line', function() {
        zat.compileFile('spec/test.z80');

        const bytes = [];
        zat.onIoWrite = (port, value) => {
            expect(port & 0xff).toBe(8);
            bytes.push(value);
        }
        zat.onIoRead = (port) => {
            expect(port & 0xff).toBe(9);
            return 0x00;
        }
        zat.load('Hello\0', 0x5000);
        zat.z80.hl = 0x5000;
        zat.call('write_line', 0xFF00);
        expect(bytes).toEqual(stringToBytes('Hello'));
    });

    it('should read a character', function() {
        zat.compileFile('spec/test.z80');

        let ioSpy = new IoSpy().returnValues([9, 0xff], [9, 0xff], [9, 0xff], [9, 0], [8, 65]);
        zat.onIoRead = ioSpy.readSpy();
        zat.call('read_char', 0xFF00);
        expect(zat.z80.a).toEqual(65);
        expect(ioSpy).toBeComplete();
    });

    it('should sound bell', function() {
        zat.compileFile('spec/test.z80');

        const values = [];
        let count = 0;
        zat.onMemRead = (addr) => {
            if (addr == zat.getAddress('sound_bell1')) {
                count++;
            }
            return undefined;
        }
        zat.onIoWrite = (port, value) => {
            values.push([port & 0xff, value]);
        }
        zat.call('sound_bell', 0xFF00);
        expect(values).toEqual([[6, 0xff], [6, 0]]);
        expect(count).toEqual(0x100 * 0x10 - 1);
    });

    it('should read and write', function() {
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
        const ioSpy = new IoSpy()
            .expectValues(5, 1)
            .returnValues(6, 27)
            .expectValues(7, 27)
            .returnValues(8, 11)
            .expectValues([1, 100], [2, 100])
            .returnValues([2, 1], [2, 2])
            .expectValues(1, 2)
        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('start', 0xFF00);
        expect(ioSpy).toBeComplete();
    })
});