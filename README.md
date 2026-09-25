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
        expect(zat.z80.regs.a).toBe(0x12);
        expect(zat.flags.Z).toBe(0);
    });

This compiles a block of Z80 code, and then runs it up to the breakpoint, and then checks that a register is correct. I'm using it with Vitest, but zat doesn't depend on a
particular test framework.

The registers are in `zat.z80.regs` (`a`, `f`, `bc`, `hl`, `afPrime`, `ix`, `sp`, `pc` etc.), and
`zat.flags` gives the flags in F as 0 or 1 (`zat.flags.Z`, `zat.flags.C` etc.), which can also be
set. `zat.altFlags` does the same for F'.

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
use an IoSpy to respond to IN instructions, and check OUT instructions. If the IO doesn't happen
as expected, an `IoSpyError` is thrown, which stops the code running and fails the test:

    it('should read a character', function() {
        zat.compileFile('spec/test.z80');

        let ioSpy = new IoSpy(zat).onIn([9, '\xff\xff\xff\0'], [8, 65]);
        zat.onIoRead = ioSpy.readSpy();
        zat.z80.regs.sp = 0xFF00;
        zat.call('read_char');
        expect(zat.z80.regs.a).toEqual(65);
        expect(ioSpy).toBeComplete();
    });

I'm using z80asm from z88dk (https://github.com/z88dk/z88dk) to compile the code, and
Lawrence Kesteloot's z80-emulator (https://github.com/lkesteloot/trs80) to run the code. The
emulator passes the FUSE emulator's Z80 tests, including the undocumented instructions and flags,
and counts T-states. It's copied into `src/vendor`; see the README there for details.

z80asm needs to be installed. By default zat runs `z88dk.z88dk-z80asm` (the name of the snap
version); set the `ZAT_Z80ASM` environment variable, or pass `{ z80asm: 'z80asm' }` to
`new Compiler()`, to use a different executable. Source files are assembled in a temporary
directory in `node_modules/.cache/zat`, because the snap version can't see `/tmp`. Set
`ZAT_TMPDIR`, or pass `{ tmpDir: '...' }`, to change it.

z80asm leaves constants which the code doesn't use out of its symbols, unless they're declared
`public`. So that tests can use them (e.g. for port numbers), zat finds constants defined with
`equ`, `defc` or `=`, including in included files, and declares them `public` for you. This
doesn't find constants whose names are made by macros; declare those `public` yourself.

Note that z80asm applies an `org` to the whole section it's in, so to put code at more than
one address, put each part in its own section:

        start:
            ld a,0
            halt
            section main
            org 20
        newstart:
            or a

This is licensed under the MIT licence.

Use
===

To use this in a project, you need to install these npm packages as dev-dependencies:

 * zat
 * vitest

Example:

```
mkdir my-project
cd my-project
npm init
npm i -D zat vitest
```
Add this into your package.json:
```
"scripts": {
    "test": "vitest"
}
```
Now you can create a test spec, e.g. `spec/things.spec.ts`. Something like this:
```
import { describe, it, expect, beforeEach } from 'vitest';
import { Zat, IoSpy, customMatchers } from 'zat';

expect.extend(customMatchers);

describe('things', function() {
    let zat: Zat;

    beforeEach(function() {
        zat = new Zat();
    });

    it('should do something', function() {
        zat.compileFile('test.z80');
        zat.run(0);
        expect(zat.z80.regs.a).toBe(5);
    })
});
```
To use the `toBeComplete()` matcher from TypeScript, you'll also need to declare its type, e.g. in
`spec/matchers.d.ts`:
```
export {};

declare module 'vitest' {
    interface Matchers<
        R extends void | Promise<void> = void | Promise<void>,
        T = unknown,
    > {
        toBeComplete(): R;
    }
}
```
