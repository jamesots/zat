Z80 Automated Testing

This is the beginnings of a project to enable Test Driven Development
for Z80 programmes.

The idea is that you can do something like this:

    it('should work', function() {
        zat.compile(`
        start:
            ld a,0
            halt
            org 20
        newstart:
            ld a,$12
            nop
            nop
        breakhere:
            ld a,$ff
            halt
        `)
        zat.run('newstart', {breakAt:'breakhere'});
        expect(zat.registers.a).toBe(0x12);
    });

This compiles a block of Z80 code, and then runs it up to the breakpoint, and then checks that a register is correct. I'm using it in Jasmine; I imagine it would also work just fine in Mocha.

You can also load data directly into memory:

    zat.load([0x3e, 0x12, 0xd3, 0x56, 0x76], 0x100);

And you can compile an external file:

    zat.compileFile('spec/test.z80');

You can write functions to handle memory and io reads and writes. I intend to improve this part
of the system so that you can read back the io activity automatically after running a test.

    beforeEach(function() {
        zat = new Zat();
        zat.memRead = (addr) => {
            console.log(`read ${addr.toString(16)}`);
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

I'm using ASM80 (https://github.com/maly/asm80-node) to compile the code, and a modified version
of Z80.js (https://github.com/DrGoldfire/Z80.js) to run the code.

This is licensed under the MIT licence.