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

This compiles a block of Z80 code, and then runs it up to the breakpoint, and then checks that a
register is correct. I'm using it with Vitest, but zat doesn't depend on a
particular test framework; see [Other test frameworks](#other-test-frameworks).

`run()` and `call()` return `{ instructions, tStates, coverage }`: the number of instructions
executed, the number of T-states they took, and how many times each address was executed.

Symbols are case-sensitive, as they are in z80asm.

To test interrupt handlers, `zat.interrupt()` raises an interrupt, or `run()` and `call()` can raise
them regularly:

    zat.call('main_loop', { interruptEvery: 69888 });

This raises a maskable interrupt every 69888 T-states (a 50Hz frame on a 3.5MHz ZX Spectrum), or a
non-maskable one if `interruptNonMaskable: true` is also passed. As on a real Z80, an interrupt is
missed if interrupts are disabled when it's raised, and one raised straight after `EI` is accepted
after the next instruction. After a `HALT`, the CPU waits for the next interrupt. The result
includes the number of interrupts accepted.

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

You can use an IoSpy to respond to IN instructions, and check OUT instructions. If the IO doesn't
happen as expected, an `IoSpyError` is thrown, which stops the code running and fails the test.
Ports can be numbers or symbols. Only the low 8 bits of the port address are compared, unless the
expected port is more than `$FF`, in which case all 16 bits must match:

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

Assembled code is cached, in memory and in `node_modules/.cache/zat/cache`, so code which hasn't
changed isn't assembled again. A cached result is only used if the code, the z80asm options, and
any files it includes with `include`, `binary` or `incbin` are the same. Entries which haven't been
used for 30 days are deleted. The cache doesn't know which version of z80asm made its entries, so
delete the cache directory if you upgrade z80asm. To turn caching off, set `ZAT_CACHE=0`, or pass
`{ cache: false }` to `new Compiler()`.

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

In watch mode, Vitest re-runs tests when files they import change. Z80 source files are read by
zat rather than imported, so Vitest won't re-run the tests when you edit one, unless you tell it
to in `vitest.config.mts`:
```
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        forceRerunTriggers: [
            ...configDefaults.forceRerunTriggers,
            '**/*.z80',
            '**/*.asm',
            '**/*.inc',
        ],
    },
});
```
This re-runs all the tests when any Z80 source file changes. Only the changed code is assembled
again, as the rest comes from the cache.

Coverage
========

zat records which lines of your Z80 source files are executed, and can write them to an lcov file,
e.g. for an editor extension such as Coverage Gutters to show, or for `genhtml` to make a report
from. Only code assembled from files (with `compileFile()`, or files they include) is recorded, not
code passed to `compile()` as a string. Data lines, such as `db`, and uses of macros which only
contain data, aren't counted as code.

Each test file's coverage needs saving when it finishes, and then combining when all the tests have
run. With Vitest, create `spec/setup.ts`:
```
import { afterAll } from 'vitest';
import { saveCoverage } from 'zat';

afterAll(() => saveCoverage());
```
and `spec/global-setup.ts`:
```
import { clearSavedCoverage, writeLcov } from 'zat';

export function setup() {
    clearSavedCoverage();
}

export function teardown() {
    writeLcov();
}
```
and add them to `vitest.config.mts`:
```
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['spec/setup.ts'],
        globalSetup: ['spec/global-setup.ts'],
    },
});
```
The coverage is written to `coverage/z80/lcov.info`. `saveCoverage()` and `writeLcov()` take
arguments to change where the coverage is saved and written.

In watch mode, the lcov file is only written when Vitest exits, and its counts include every run.

Other test frameworks
=====================

zat reports failures by throwing errors: `IoSpy` throws an `IoSpyError`, and `getAddress()` and
z80asm failures throw an `Error`. Every test framework treats these as failures, so most of zat
works with any of them.

The `toBeComplete()` matcher uses the `expect.extend()` format of Vitest and Jest. With other
frameworks, check the spy directly instead:
```
assert.ok(ioSpy.allDone());         // node:test, or Mocha with node:assert
expect(ioSpy.allDone()).toBe(true); // Jasmine
expect(ioSpy.allDone()).to.be.true; // Chai
```

For coverage, call `clearSavedCoverage()` before the tests run, `saveCoverage()` at the end of each
process that runs tests, and `writeLcov()` once all the tests have finished. `writeLcov()` only
reads saved coverage, so call `saveCoverage()` first even if all the tests run in one process.

| Framework  | Before the tests                   | After each process                           | After all the tests                    |
|------------|------------------------------------|----------------------------------------------|----------------------------------------|
| Jest       | `globalSetup` module               | `afterAll` in a `setupFilesAfterEnv` file    | `globalTeardown` module                |
| Mocha      | `mochaGlobalSetup`                 | `afterAll` in `mochaHooks`                   | the same hook, after `saveCoverage()`  |
| Jasmine    | `beforeAll` in a helper file       | `afterAll` in a helper file                  | the same hook, after `saveCoverage()`  |
| node:test  | a command before the tests         | `after()` in each test file                  | a command after the tests              |

Mocha and Jasmine run all the tests in one process by default. With Mocha's `--parallel`, write the
lcov file in `mochaGlobalTeardown` instead. With any framework, the first and last steps can be
separate commands:
```
node -e "require('zat').clearSavedCoverage()" && node --test && node -e "require('zat').writeLcov()"
```

zat is compiled to CommonJS with type declarations, so any framework can load it. Your test files
need the framework's TypeScript support, e.g. `ts-jest` for Jest, or `tsx` for Mocha. `node:test`
can run TypeScript test files itself, as long as they don't use syntax which needs converting, such
as `enum`s.

zat's cache and coverage files are safe to use from several processes at once, so frameworks which
run tests in parallel worker processes work too.
