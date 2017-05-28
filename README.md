Z80 Automated Testing
=====================

This is the beginnings of a project to enable Test Driven Development
for Z80 programmes.

**WARNING:** This is a work in progress, and the API is likely to change.

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
        zat.setBreakpoint('breakhere');
        zat.run('newstart');
        expect(zat.z80.a).toBe(0x12);
    });

This compiles a block of Z80 code, and then runs it up to the breakpoint, and then checks that a register is correct. I'm using it in Jasmine; I imagine it would also work just fine in Mocha.

You can also load data directly into memory:

    zat.load([0x3e, 0x12, 0xd3, 0x56, 0x76], 0x100);

And you can compile an external file:

    zat.compileFile('spec/test.z80');

You can write functions to handle memory and io reads and writes.

    beforeEach(function() {
        zat = new Zat();
        zat.onMemRead = (addr) => {
            console.log(`read ${addr.toString(16)}`);
            return undefined;
        }
        zat.onIoWrite = (port, value) => {
            console.log(`OUT ${port.toString(16)}, ${value.toString(16)}`);
        }
        zat.onIoRead = (port) => {
            console.log(`IN ${port.toString(16)}`);
            return 0x00;
        }
    });

I am working on improving this part
of the system so that you can read back the io activity automatically after running a test. You can
use an IoSpy to respond to IN instructions:

    it('should read a character', function() {
        zat.compileFile('spec/test.z80');

        let ioSpy = new IoSpy().returnValues([[9, 0xff], [9, 0xff], [9, 0xff], [9, 0], [8, 65]]);
        zat.onIoRead = ioSpy.readSpy();
        zat.z80.sp = 0xFF00;
        zat.call('read_char');
        expect(zat.z80.a).toEqual(65);
        expect(ioSpy).toBeComplete();
    });

I'm using ASM80 (https://github.com/maly/asm80-node) to compile the code, and a modified version
of Z80.js (https://github.com/DrGoldfire/Z80.js) to run the code.

This is licensed under the MIT licence.

Use
===

To use this in a project, you need to install these npm packages as dev-dependencies:
 
 * zat
 * typescript
 * jasmine
 * jasmine-ts
 * @types/jasmine

Example:

```
mkdir my-project
cd my-project
npm init
npm i -D zat typescript jasmine jasmine-ts @types/jasmine
./node_modules/.bin/jasmine init
```
Then add this into your package.json:
```
"scripts": {
    "test": "jasmine-ts 'spec/**/*.spec.ts'"
}
```
Now you can create a test spec in the spec directory. Something like this:
```
import { Zat, IoSpy, StepMock, customMatchers, stringToBytes, hex16, Compiler, CompiledProg, Z80 } from 'zat';

describe('things', function() {
    let zat: Zat;
    let prog: CompiledProg;

    beforeEach(function() {
        jasmine.addMatchers(customMatchers as any);

        zat = new Zat();
    });

    it('should do something', function() {
        zat.compileFile('test.z80');
        zat.run(0);
        expect(zat.z80.a).toBe(5);
    })
});
```
