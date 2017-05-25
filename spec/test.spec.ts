import { Z80 } from '../src/z80/Z80';
import { Compiler, CompiledProg } from '../src/compiler';
import { Zat, IoSpy, customMatchers, stringToBytes, hex16 } from '../src/zat';

describe('things', function() {
    let zat: Zat;
    let prog: CompiledProg;

    beforeAll(function() {
        prog = new Compiler().compileFile('spec/test.z80');
    });

    beforeEach(function() {
        jasmine.addMatchers(customMatchers as any);

        zat = new Zat();
    });

    it('should work with a compiled file', function() {
        zat.loadProg(prog);
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
        zat.loadProg(prog);
        zat.onStep = (pc) => pc === zat.getAddress('breakhere');
        zat.run('newstart');
        expect(zat.z80.a).toBe(0x12);
        expect(zat.z80.flags.Z).toBe(1);

        // expect(zat.memoryAt('line', 10)).toBe('hello\0');
    });

    it('should work with a compiled file and compiled string', function() {
        zat.loadProg(prog);
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
        zat.loadProg(prog);

        zat.load('Hello\0', 0x5000);
        let ioSpy = new IoSpy()
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
        zat.z80.hl = 0x5000;
        zat.call('write_line', 0xFF00);
        expect(ioSpy).toBeComplete();
    });

    it('should read a character', function() {
        zat.loadProg(prog);

        let ioSpy = new IoSpy().onIn([9, '\xff\xff\0'], [8, 65]);
        zat.onIoRead = ioSpy.readSpy();
        zat.call('read_char', 0xFF00);
        expect(zat.z80.a).toEqual(65);
        expect(ioSpy).toBeComplete();
    });

    it('should sound bell', function() {
        zat.loadProg(prog);

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
            .onOut(5, 1)
            .onIn(6, 27)
            .onOut(7, 27)
            .onIn(8, 11)
            .onOut([1, 100], [2, 100])
            .onIn([2, 1], [2, 2])
            .onOut(1, 2)
        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('start', 0xFF00);
        expect(ioSpy).toBeComplete();
    });

    it('should read a line', function() {
        zat.loadProg(prog);

        // Create two separate spies, so that the order of reads and writes doesn't matter.
        // It does, but I'm trying to test the bigger picture. Can do the order in another test.
        const readSpy = new IoSpy()
            .onIn(8, '\x08heg\x08llo\r') // add some deletes in here
            .readSpy();
        const writeSpy = new IoSpy()
            // the first delete should ring the bell, as the buffer is empty
            .onOut([6, 0xff], [6, 0], [8, 'heg\x08llo\r'])
            .writeSpy();
        zat.onIoRead = (port) => {
            // If it's the ftdi_status port, always return 0 (ready)
            if ((port & 0xff) === 9) {
                return 0;
            }
            // ...otherwise use the spy
            return readSpy(port);
        }
        zat.onIoWrite = writeSpy;
        zat.call('read_line');
        expect(zat.getMemory('line', 6)).toEqual(stringToBytes('hello\0'));
    });

    it('should read a line - details', function() {
        zat.loadProg(prog);

        const ioSpy = new IoSpy()
            .onIn([9, 0], [8, 8]) // read a backspace
            .onOut([6, [0xff, 0]]) // sound bell
            .onIn([9, 0], [8, 'h'], [9, 0]) // read 'h', check we can write
            .onOut([8, 'h']) // write 'h'
            .onIn([9, 0], [8, '\r'], [9, 0]) // read CR, check we can write
            .onOut([8, '\r'])  // write CR

        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('read_line');
        expect(zat.getMemory('line', 2)).toEqual(stringToBytes('h\0'));
    })
});