# zat documentation

zat (Z80 Automated Testing) lets you write unit tests for Z80 assembly code in TypeScript or
JavaScript. It assembles your code with z80asm, runs it in a Z80 emulator, and gives your tests
control over memory, registers, IO, interrupts and subroutine calls.

This document covers everything zat provides. For a shorter introduction, see the
[README](README.md).

- [Requirements](#requirements)
- [Installation and setup](#installation-and-setup)
- [A first test](#a-first-test)
- [Assembling code](#assembling-code)
- [Memory and symbols](#memory-and-symbols)
- [Registers and flags](#registers-and-flags)
- [Running code](#running-code)
- [Interrupts](#interrupts)
- [Breakpoints and mocking](#breakpoints-and-mocking)
- [Memory and IO hooks](#memory-and-io-hooks)
- [IoSpy](#iospy)
- [Matchers](#matchers)
- [Coverage](#coverage)
- [Debugging output](#debugging-output)
- [Utility functions](#utility-functions)
- [The Z80 emulator](#the-z80-emulator)
- [Using other test frameworks](#using-other-test-frameworks)
- [Environment variables](#environment-variables)
- [Everything zat exports](#everything-zat-exports)

## Requirements

- **Node.js.** zat is developed with Node.js 24.
- **z80asm**, from [z88dk](https://github.com/z88dk/z88dk). zat runs `z88dk.z88dk-z80asm` by
  default, which is the name of the command in the z88dk snap. If yours is called something else,
  such as `z80asm`, set the `ZAT_Z80ASM` environment variable to its name or path.

## Installation and setup

zat works with any test framework (see [Using other test frameworks](#using-other-test-frameworks)),
but these instructions use [Vitest](https://vitest.dev), which runs TypeScript tests without a
build step.

```
npm i -D zat vitest
```

Add a test script to `package.json`:

```json
"scripts": {
    "test": "vitest"
}
```

Create `vitest.config.mts`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['spec/**/*.spec.ts'],
        // Re-run the tests in watch mode when Z80 source files change
        forceRerunTriggers: [
            ...configDefaults.forceRerunTriggers,
            '**/*.z80',
            '**/*.asm',
            '**/*.inc',
        ],
    },
});
```

Vitest re-runs tests in watch mode when the files they import change. Z80 source files are read by
zat rather than imported, so `forceRerunTriggers` tells Vitest to re-run the tests when they
change. Any change re-runs all the tests, but only the changed code is assembled again, as the
rest comes from zat's [cache](#caching).

To also get a coverage report of your Z80 code, see [Coverage](#coverage).

zat writes temporary files and its cache to `node_modules/.cache/zat`, and coverage to `coverage/`,
so add `coverage` to your `.gitignore` if you use it.

## A first test

Put some Z80 code in `src/maths.z80`:

```
; Add B to A, and return the result in A
add_b:
    add a,b
    ret
```

and a test in `spec/maths.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Zat } from 'zat';

describe('add_b', () => {
    let zat: Zat;

    beforeEach(() => {
        zat = new Zat();
        zat.defaultCallSp = 0xff00;
        zat.compileFile('src/maths.z80');
    });

    it('should add B to A', () => {
        zat.z80.regs.a = 2;
        zat.z80.regs.b = 3;
        zat.call('add_b');
        expect(zat.z80.regs.a).toBe(5);
        expect(zat.flags.C).toBe(0);
    });

    it('should set carry on overflow', () => {
        zat.z80.regs.a = 0xff;
        zat.z80.regs.b = 2;
        zat.call('add_b');
        expect(zat.z80.regs.a).toBe(1);
        expect(zat.flags.C).toBe(1);
    });
});
```

`npm test` runs the tests. Each test gets a new `Zat`, which is a Z80 with 64K of RAM. The code is
assembled and loaded into it, the registers are set up, and `call()` runs the `add_b` subroutine
until it returns.

## Assembling code

### `zat.compile(code, loadAt?)`

Assembles a string of Z80 code, loads it into memory, and adds its symbols to
[`zat.symbols`](#symbols). Returns a [`CompiledProg`](#compiledprog).

```ts
zat.compile(`
start:
    ld a,5
    call double
    halt
double:
    add a,a
    ret
`);
zat.run('start');
expect(zat.z80.regs.a).toBe(10);
```

The code is loaded at its origin: the address given by `org`, or 0 if there's no `org`. If `loadAt`
is given, the code is loaded there instead. It can be an address or a symbol. The code isn't
reassembled, so any addresses in it are still the ones for its origin.

```ts
zat.compile(' org 5\n ret');     // loads c9 at address 5
zat.compile(' ret');             // loads c9 at address 0
zat.compile(' org 5\n ret', 10); // loads c9 at address 10
```

`include` files in code passed to `compile()` are looked for relative to the current directory.

Errors from z80asm are thrown as an `Error`, with z80asm's messages. Line numbers in them refer to
the code string, which is called `code`:

```
z80asm failed: code:3: error: syntax error
  ^---- bad x
```

Code assembled with `compile()` isn't included in [coverage](#coverage), as it's part of the test
rather than the code being tested.

### `zat.compileFile(filename, loadAt?)`

Like `compile()`, but assembles a file. `include` files are looked for relative to the file's
directory, as well as the current directory. Returns a `CompiledProg`.

```ts
zat.compileFile('src/maths.z80');
```

### `zat.loadProg(prog, loadAt?)`

Loads a `CompiledProg` into memory, and adds its symbols to `zat.symbols`. `loadAt` works as it does
for `compile()`.

Assembling a file once and loading it into a new `Zat` for each test saves reassembling it (though
zat's [cache](#caching) makes reassembling fast anyway):

```ts
import { Compiler, CompiledProg, Zat } from 'zat';

let prog: CompiledProg;
let zat: Zat;

beforeAll(() => {
    prog = new Compiler().compileFile('src/maths.z80');
});

beforeEach(() => {
    zat = new Zat();
    zat.loadProg(prog);
});
```

Several programs can be loaded into the same `Zat`, and they share its symbol table.

### z80asm syntax

zat uses z80asm from z88dk, so code must use its syntax. Some things to know:

- **Strings** in `db` use double quotes: `db "hello", 0`.
- **Macros** are defined with `macro name args` and `endm`.
- **Hex numbers** can be written `$ff`, `0ffh` or `0xff`.
- **Constants** can be defined with `name: equ value`, `defc name = value`, or `name = value`.
- **`org` applies to a whole section.** A second `org` part way through doesn't leave a gap; it
  moves the whole section. To put code at more than one address, put each part in its own section:

  ```
  start:
      jp main
      section interrupt
      org $38
      ; interrupt handler here
      reti
      section main
      org $100
  main:
      ; ...
  ```

- **Unused constants.** z80asm leaves constants that the code doesn't use out of its symbol table,
  unless they're declared `public`. So that tests can use them, e.g. for port numbers, zat finds
  constants defined with `equ`, `defc` or `=`, including in included files, and declares them
  `public` for you. It can't find constants whose names are made by macros; declare those `public`
  yourself.

See the [z80asm documentation](https://github.com/z88dk/z88dk/wiki/Tool---z80asm) for everything
else.

### `Compiler`

`zat.compile()` and `zat.compileFile()` use a `Compiler` with the default options. To use other
options, use a `Compiler` directly, and load the result with `zat.loadProg()`.

```ts
import { Compiler } from 'zat';

const compiler = new Compiler({ args: ['-mz180'] });
zat.loadProg(compiler.compileFile('src/z180.asm'));
```

`new Compiler(options?)` takes a `CompilerOptions` object:

| Option   | Default                                        | Description                                                       |
|----------|------------------------------------------------|-------------------------------------------------------------------|
| `z80asm` | `$ZAT_Z80ASM`, or `z88dk.z88dk-z80asm`         | The z80asm command.                                               |
| `tmpDir` | `$ZAT_TMPDIR`, or `node_modules/.cache/zat`    | Where temporary files and the cache are kept.                     |
| `args`   | `[]`                                           | Extra arguments for z80asm, e.g. `['-mz180']` for a Z180.         |
| `cache`  | `true`, unless `$ZAT_CACHE` is `0`             | Whether to [cache](#caching) assembled code.                      |

`tmpDir` isn't the system's temporary directory because the z88dk snap can't see `/tmp`. If you
change it, it must be somewhere that z80asm can read and write.

Methods:

- **`compile(code, includeDir?, name?)`** assembles a string, and returns a `CompiledProg`.
  `includeDir` is where `include` files are looked for, and defaults to the current directory.
  `name` is used for the code in error messages and the listing, and defaults to `code`.
- **`compileFile(filename)`** assembles a file, and returns a `CompiledProg`.
- **`Compiler.clearMemoryCache()`** (static) empties the in-memory cache. The cache directory
  isn't changed.

### Caching

Running z80asm takes a noticeable time, so assembled code is cached, in memory and in
`node_modules/.cache/zat/cache`. A cached result is only used if the code, the name, the include
directory, the z80asm command and its arguments are the same, and none of the files included with
`include`, `binary` or `incbin` have changed.

Cache entries that haven't been used for 30 days are deleted. The cache doesn't know which version
of z80asm made an entry, so delete `node_modules/.cache/zat/cache` if you upgrade z80asm.

To turn caching off, set `ZAT_CACHE=0`, or pass `{ cache: false }` to `new Compiler()`.

### `CompiledProg`

The result of assembling some code.

| Property   | Type                              | Description                                                                                  |
|------------|-----------------------------------|----------------------------------------------------------------------------------------------|
| `data`     | `Buffer`                          | All the assembled bytes, from `origin` to the end of the last segment. Gaps are filled with zeros. |
| `origin`   | `number`                          | The address of the first byte of `data`.                                                     |
| `segments` | `Segment[]`                       | The assembled bytes of each section, as `{ address, data }`, in address order.               |
| `symbols`  | `{ [symbol: string]: number }`    | The symbols, i.e. labels and constants, and their values.                                    |
| `list`     | `string[]`                        | The lines of z80asm's listing.                                                               |
| `lines`    | `ListingLine[]`                   | The lines of source code that produced bytes.                                                |

`prog.dumpList()` prints the listing.

Each `ListingLine` has:

| Property  | Type      | Description                                                                          |
|-----------|-----------|--------------------------------------------------------------------------------------|
| `file`    | `string`  | The source file, or the `name` passed to `Compiler.compile()`, e.g. `code`.          |
| `line`    | `number`  | The line number in the file.                                                         |
| `address` | `number`  | The address of the line's first byte.                                                |
| `length`  | `number`  | The number of bytes.                                                                 |
| `source`  | `string`  | The source code.                                                                     |
| `data`    | `boolean` | Whether the line is data: a data directive like `db`, or a macro that only contains data directives. |

## Memory and symbols

### `zat.memory`

The 64K of RAM, as a `Uint8Array`. Tests can read and write it directly:

```ts
zat.memory[0x8000] = 0x42;
expect(zat.memory[0x8001]).toBe(0);
```

Reading or writing `zat.memory` doesn't call the [memory hooks](#memory-and-io-hooks); only the
emulated CPU's reads and writes do.

### `zat.load(data, start = 0)`

Copies bytes into memory. `data` can be an array of numbers, a `Uint8Array`, or a string, whose
character codes are used. `start` is an address or a symbol.

```ts
zat.load([0x3e, 0x12, 0x76], 0x100);
zat.load('Hello\0', 'buffer');
```

### `zat.getMemory(start, length)`

Returns `length` bytes of memory from `start`, which is an address or a symbol, as an array of
numbers.

```ts
expect(zat.getMemory('buffer', 6)).toEqual(stringToBytes('hello\0'));
```

### Symbols

`zat.symbols` is the symbol table: an object mapping each symbol's name to its value. Symbols are
added when code is assembled or loaded. They're case-sensitive, as they are in z80asm.

Wherever zat takes an address, you can use a symbol name instead.

- **`zat.getAddress(addr)`** returns the value of a symbol, or `addr` itself if it's a number. It
  throws an `Error` if the symbol doesn't exist, which suggests the right name if only the case is
  different: `Symbol "FOO" not found (did you mean "Foo"?)`.
- **`zat.getSymbol(addr)`** returns the name of a symbol whose value is `addr`, or `''` if there
  isn't one.

### `zat.saveMemory()` and `zat.loadMemory(saved)`

`saveMemory()` returns a copy of the memory and the symbol table, as a `SavedMemory` object
(`{ memory, symbols }`). `loadMemory(saved)` puts them back. Registers aren't saved.

```ts
const saved = zat.saveMemory();
zat.call('clear_screen');
zat.loadMemory(saved);
```

## Registers and flags

### `zat.z80.regs`

The registers are in `zat.z80.regs`, and can be read and set:

```ts
zat.z80.regs.hl = 0x4000;
zat.z80.regs.a = 5;
expect(zat.z80.regs.de).toBe(0x1234);
```

| Registers                                  | Description                                       |
|--------------------------------------------|---------------------------------------------------|
| `af`, `bc`, `de`, `hl`                     | The 16-bit register pairs.                        |
| `a`, `f`, `b`, `c`, `d`, `e`, `h`, `l`     | The 8-bit registers, which are part of the pairs. |
| `afPrime`, `bcPrime`, `dePrime`, `hlPrime` | The alternate register pairs, `AF'` etc.          |
| `ix`, `iy`                                 | The index registers.                              |
| `ixh`, `ixl`, `iyh`, `iyl`                 | The halves of the index registers.                |
| `sp`, `pc`                                 | The stack pointer and program counter.            |
| `i`, `r`                                   | The interrupt vector and refresh registers.       |
| `iff1`, `iff2`                             | The interrupt flip-flops, 0 or 1.                 |
| `im`                                       | The interrupt mode, 0, 1 or 2.                    |
| `halted`                                   | 1 if the CPU is halted, otherwise 0.              |
| `memptr`                                   | The CPU's internal MEMPTR (WZ) register.          |

All registers start at 0 when a `Zat` is created, including `sp`, so set `sp` (or
[`defaultCallSp`](#zatcallstart-options)) before running code that uses the stack.

### `zat.flags` and `zat.altFlags`

`zat.flags` gives the flags in F as 0 or 1, and `zat.altFlags` does the same for F'. Setting a flag
changes the register; `true` and `false` can be used as well as 1 and 0.

```ts
expect(zat.flags.Z).toBe(1);
zat.flags.C = 0;
zat.altFlags.C = true;
```

| Flag | Bit | Description                                   |
|------|-----|-----------------------------------------------|
| `S`  | 7   | Sign                                          |
| `Z`  | 6   | Zero                                          |
| `Y`  | 5   | Undocumented copy of bit 5 of a result        |
| `H`  | 4   | Half carry                                    |
| `X`  | 3   | Undocumented copy of bit 3 of a result        |
| `P`  | 2   | Parity                                        |
| `V`  | 2   | Overflow, which is the same bit as parity     |
| `N`  | 1   | Subtract                                      |
| `C`  | 0   | Carry                                         |

Converting the flags to a string gives each flag's letter if it's set, or `.` if it isn't, in the
order `SZYHXPNC`:

```ts
expect(`${zat.flags}`).toBe('.Z.....C');
```

The `Flag` enum has the value of each bit (`Flag.C` is `0x01`, `Flag.Z` is `0x40`, and so on, with
`Flag.X3` and `Flag.X5` for the undocumented bits), for working with `regs.f` directly:

```ts
import { Flag } from 'zat';

expect(zat.z80.regs.f & Flag.C).toBe(Flag.C);
```

## Running code

### `zat.run(start?, options?)`

Runs code, starting at `start` (an address or a symbol) if it's given, or else at the current PC.
It stops when:

- a `HALT` is executed (unless [interrupts](#interrupts) are being raised),
- the next instruction is at a [breakpoint](#breakpoints),
- a [step mock](#zatmockstepaddr-func) returns `StepResponse.BREAK`,
- `options.steps` instructions have been executed, or
- with the `call` option, the routine returns (see [`call()`](#zatcallstart-options)).

`options.steps` defaults to 10,000,000, so a test with an endless loop fails rather than hanging.

After a `HALT`, the PC is left pointing at the `HALT` instruction, and `regs.halted` is 1. If
`run()` is then called without a start address, it carries on after the `HALT`.

```ts
zat.compile(`
start:
    ld a,1
    halt
    ld a,2
    halt
`);
zat.run('start');
expect(zat.z80.regs.a).toBe(1);
zat.run();
expect(zat.z80.regs.a).toBe(2);
```

`run()` returns a `RunResult`:

| Property       | Description                                                         |
|----------------|---------------------------------------------------------------------|
| `instructions` | The number of instructions executed.                                |
| `tStates`      | The number of T-states (clock cycles) taken, including interrupts.  |
| `interrupts`   | The number of interrupts accepted.                                  |
| `coverage`     | The number of times the instruction at each address was executed, as `{ [address]: count }`. |

T-state counts are accurate, so tests can check how long code takes:

```ts
const { tStates } = zat.call('copy_screen');
expect(tStates).toBeLessThan(70000);
```

`options` is a `RunOptions` object:

| Option                 | Description                                                                          |
|------------------------|--------------------------------------------------------------------------------------|
| `steps`                | The maximum number of instructions to execute. Defaults to 10,000,000.               |
| `call`                 | Stop when the routine returns. `call()` sets this.                                   |
| `sp`                   | Used by `call()`: the stack pointer to start with.                                   |
| `coverage`             | A `coverage` object from an earlier run, to add this run's counts to.                |
| `interruptEvery`       | Raise an interrupt every this many T-states. See [Interrupts](#interrupts).          |
| `interruptNonMaskable` | Make the interrupts raised by `interruptEvery` non-maskable.                         |

### `zat.call(start?, options?)`

Runs a subroutine until it returns, as if it had been called with `CALL`. Takes the same options
and returns the same result as `run()`.

zat notes the stack pointer when it starts, and stops when a `RET` (or `RETI` or `RETN`) leaves the
stack pointer 2 higher than that: the point at which the routine returns to its caller. zat doesn't
push a return address, so after the `RET`, the PC is whatever word was at the top of the stack.

The stack pointer is set before running, if an `sp` option is given, or if `zat.defaultCallSp` is
set. Both can be addresses or symbols. Setting `defaultCallSp` in a `beforeEach` saves setting it
in every test:

```ts
beforeEach(() => {
    zat = new Zat();
    zat.defaultCallSp = 0xff00;
});

it('should read a character', () => {
    zat.call('read_char');
    // ...
});
```

### `zat.step()`

Executes one instruction, and returns the number of T-states it took. Unlike `run()`, it doesn't
check breakpoints or step mocks, or count coverage.

### `zat.lastInstruction`

What kind of instruction was executed last, as an `InstructionType`:

| Value                     | Meaning                                                  |
|---------------------------|----------------------------------------------------------|
| `InstructionType.CALL`    | A `CALL` which was taken.                                |
| `InstructionType.RET`     | A `RET`, `RETI` or `RETN` which was taken.               |
| `InstructionType.RST`     | An `RST`.                                                |
| `InstructionType.INT`     | An interrupt was accepted.                               |
| `InstructionType.OTHER`   | Anything else, including conditional calls and returns which weren't taken. |

## Interrupts

### `zat.interrupt(nonMaskable = false)`

Raises an interrupt: maskable, or non-maskable if `nonMaskable` is true. A maskable interrupt is
ignored if interrupts are disabled. Returns the number of T-states the interrupt took, which is 0
if it was ignored.

Interrupt modes 0 and 1 jump to `$38`. In interrupt mode 2, the byte from the data bus is always
`$FF`, so the handler's address is read from `I * 256 + $FF`. Non-maskable interrupts jump to
`$66`.

```ts
zat.compile(`
    jp start
    section int
    org $38
    ld b,$42
    ei
    ret
    section main
    org $100
start:
    ld sp,$ff00
    im 1
    ei
    halt
    ld a,b
    halt
`);
zat.run('start');   // stops at the first HALT
zat.interrupt();
zat.run();          // runs the handler, then stops at the second HALT
expect(zat.z80.regs.a).toBe(0x42);
```

### Raising interrupts regularly

The `interruptEvery` option of `run()` and `call()` raises an interrupt every so many T-states,
e.g. to test code that relies on a frame interrupt:

```ts
const { interrupts } = zat.call('main_loop', { interruptEvery: 69888 });
```

69888 T-states is a 50Hz frame on a 3.5MHz ZX Spectrum. The first interrupt is raised
`interruptEvery` T-states after the run starts; the timing starts again with each run. The
interrupts are maskable, unless the `interruptNonMaskable` option is `true`.

As on a real Z80:

- an interrupt is missed if interrupts are disabled when it's raised,
- an interrupt raised straight after `EI` is accepted after the next instruction, so a handler can
  end with `ei` and `ret` without being interrupted again before it returns, and
- after a `HALT`, the CPU waits for the next interrupt. If interrupts are disabled, it would wait
  forever, so the run stops at the `HALT` instead.

The result's `interrupts` property is the number of interrupts accepted.

[Breakpoints](#breakpoints) and [`mockCall()`](#zatmockcalladdr-func) work on interrupt handlers,
so a test can replace a handler, or stop when it's reached.

## Breakpoints and mocking

### Breakpoints

- **`zat.setBreakpoint(addr)`** makes `run()` and `call()` stop before executing the instruction
  at `addr`, which is an address or a symbol.
- **`zat.clearBreakpoint(addr)`** removes a breakpoint.

```ts
zat.setBreakpoint('check');
zat.run('start');
expect(zat.z80.regs.a).toBe(0x12);
```

### `zat.mockCall(addr, func)`

Replaces a subroutine. Whenever `addr` is reached by a `CALL`, an `RST` or an interrupt, `func` is
called instead of running the subroutine, and then execution returns to the caller. If `addr` is
reached in any other way, e.g. by a jump or by running into it, it runs as normal.

`func` can change registers and memory, e.g. to return a result:

```ts
zat.mockCall('read_key', () => {
    zat.z80.regs.a = 'Y'.charCodeAt(0);
});
zat.call('ask_yes_no');
```

This is useful for replacing routines that talk to hardware, or which are slow, or which are
tested separately.

### `zat.mockStep(addr, func)`

Calls `func` before the instruction at `addr` is executed. `func` returns a `StepResponse`:

- **`StepResponse.RUN`**: execute the instruction, and carry on.
- **`StepResponse.BREAK`**: stop running, before executing the instruction.
- **`StepResponse.SKIP`**: don't execute the instruction, and carry on. `func` should change
  `zat.z80.regs.pc`, or it will be called again straight away, for the same instruction.

```ts
import { StepResponse } from 'zat';

// Skip a slow delay loop
zat.mockStep('delay', () => {
    zat.z80.regs.pc = zat.getAddress('delay_end');
    return StepResponse.SKIP;
});
```

### `zat.mockAllSteps(func)`

Like `mockStep()`, but `func` is called before every instruction, with the address of the
instruction:

```ts
zat.mockAllSteps((pc) => {
    return pc >= 0x8000 ? StepResponse.BREAK : StepResponse.RUN;
});
```

If there are several mocks for an instruction, they're called in the order they were added, until
one returns something other than `RUN`. Mocks can't be removed, so create a new `Zat` to get rid of
them.

## Memory and IO hooks

Tests can handle the CPU's memory and IO accesses by setting these properties to functions:

| Property     | Called when                         | What it returns                                                                  |
|--------------|-------------------------------------|----------------------------------------------------------------------------------|
| `onMemRead`  | The CPU reads memory.               | The byte to read, or `undefined` to read from `zat.memory` as usual.             |
| `onMemWrite` | The CPU writes memory.              | `true` if it's handled the write, or `false` to write to `zat.memory` as usual.  |
| `onIoRead`   | An `IN` instruction reads a port.   | The byte to read. Without a hook, `IN` reads 0.                                  |
| `onIoWrite`  | An `OUT` instruction writes a port. | Nothing. Without a hook, `OUT` does nothing.                                     |

`onMemRead` is called with the address, and `onMemWrite` with the address and the value.
`onIoRead` is called with the port address, and `onIoWrite` with the port address and the value.
Port addresses are 16 bits: for `IN A,(n)` and `OUT (n),A` the high byte is A, and for `IN r,(C)`
and `OUT (C),r` it's B. Use `port & 0xff` for the low byte.

Memory reads include reading instructions, so `onMemRead` can also count how often code runs:

```ts
let count = 0;
zat.onMemRead = (addr) => {
    if (addr === zat.getAddress('loop')) {
        count++;
    }
    return undefined;
};
```

To emulate ROM, ignore writes to it:

```ts
zat.onMemWrite = (addr) => addr < 0x4000;
```

To record output:

```ts
const output: number[] = [];
zat.onIoWrite = (port, value) => {
    if ((port & 0xff) === 8) {
        output.push(value);
    }
};
```

## IoSpy

An `IoSpy` checks that code does the IO you expect, in the order you expect, and provides the
values it reads. If the IO is different, the spy throws an `IoSpyError`, which stops the code and
fails the test, with a message such as `Expected OUT to port 06 of 03 but got 02`.

```ts
import { IoSpy } from 'zat';

it('should write a line', () => {
    zat.load('Hi\0', 0x5000);
    const ioSpy = new IoSpy(zat)
        .onIn(9, 0)          // read 0 from the status port
        .onOut(8, 'H')       // write 'H' to the data port
        .onIn(9, 0)
        .onOut(8, 'i');
    zat.onIoRead = ioSpy.readSpy();
    zat.onIoWrite = ioSpy.writeSpy();
    zat.z80.regs.hl = 0x5000;
    zat.call('write_line');
    expect(ioSpy.allDone()).toBe(true);
});
```

`new IoSpy(zat)` creates a spy. Its methods add expected IO, in order, and return the spy, so calls
can be chained:

- **`onIn(...values)`** expects reads, and says what they return.
- **`onOut(...values)`** expects writes, and says what should be written.
- **`sendIgnoringWrites(...values)`** is like `onIn()`, but writes are allowed, and ignored, until
  the reads have happened.
- **`receiveIgnoringReads(...values)`** is like `onOut()`, but reads are allowed, and return 0,
  until the writes have happened.

Each of these takes either a port and a value, or any number of `[port, value]` tuples:

```ts
ioSpy.onIn(9, 0);
ioSpy.onIn([9, 0], [8, 65]);
```

A port is a number or a symbol. Only the low 8 bits of the port address are compared, as the high
8 bits are usually just whatever was in A or B. If the expected port is more than `$FF`, all 16
bits are compared, e.g. for the ZX Spectrum's keyboard ports:

```ts
ioSpy.onIn([0xfbfe, 0xff], [0xfdfe, 0xfe]);
```

A value is a number, or a string or array of numbers for several reads or writes to the same port:

```ts
ioSpy.onIn(['data', 'hello\r']);  // six reads from the data port
ioSpy.onOut(['bell', [0xff, 0]]); // two writes to the bell port
```

The spy's other methods are:

- **`readSpy()`** returns a function to use as `zat.onIoRead`.
- **`writeSpy()`** returns a function to use as `zat.onIoWrite`.
- **`allDone()`** returns `true` if all the expected IO has happened.

Use `readSpy()` and `writeSpy()` from the same spy to check the order of reads and writes, or from
separate spies to check them separately. A hook can also use a spy for some ports and handle others
itself:

```ts
const readSpy = new IoSpy(zat).onIn(['data', 'hello\r']).readSpy();
zat.onIoRead = (port) => {
    // The status port always says the device is ready
    if ((port & 0xff) === zat.getAddress('status')) {
        return 0;
    }
    return readSpy(port);
};
```

`IoSpyError` is thrown when:

- a read or write uses the wrong port,
- a write writes the wrong value,
- a read happens when a write is expected, or the other way round, or
- IO happens after all the expected IO has happened.

It's also thrown by `onIn()` and the other methods if they're given no values.

## Matchers

`customMatchers` adds a `toBeComplete()` matcher for `IoSpy`s to Vitest or Jest. It passes if all
the spy's expected IO has happened.

```ts
import { expect } from 'vitest';
import { customMatchers } from 'zat';

expect.extend(customMatchers);

// ...
expect(ioSpy).toBeComplete();
```

To use it from TypeScript, declare its type, e.g. in `spec/matchers.d.ts`:

```ts
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

With other test frameworks, use `expect(ioSpy.allDone()).toBe(true)` or equivalent.

## Coverage

zat can report which lines of your Z80 source files the tests execute, as an lcov file. Editor
extensions such as Coverage Gutters can show it, and `genhtml` can make an HTML report from it.

Only code assembled from files is included: files loaded with `compileFile()`, and files they
include. Code passed to `compile()` as a string isn't included. Data, such as `db` lines and uses
of macros that only contain data, isn't counted as code. A use of a macro that contains code counts
as one line.

### Setting up coverage with Vitest

Vitest runs test files in separate processes, so each process saves its coverage, and the saved
coverage is combined at the end. Create `spec/setup.ts`:

```ts
import { afterAll } from 'vitest';
import { saveCoverage } from 'zat';

afterAll(() => saveCoverage());
```

and `spec/global-setup.ts`:

```ts
import { clearSavedCoverage, writeLcov } from 'zat';

export function setup() {
    clearSavedCoverage();
}

export function teardown() {
    writeLcov();
}
```

and add them to `vitest.config.mts`:

```ts
export default defineConfig({
    test: {
        setupFiles: ['spec/setup.ts'],
        globalSetup: ['spec/global-setup.ts'],
    },
});
```

The coverage is written to `coverage/z80/lcov.info` when the tests finish. In watch mode, it's
only written when Vitest exits, and its counts include every run.

### Coverage functions

| Function                                   | Description                                                                                  |
|--------------------------------------------|----------------------------------------------------------------------------------------------|
| `getCoverage()`                            | The coverage this process has collected since it was last saved, as a `LineCoverage`.        |
| `saveCoverage(dir?)`                       | Saves this process's coverage to a new file in `dir`, and clears it.                         |
| `clearSavedCoverage(dir?)`                 | Deletes the saved coverage in `dir`.                                                         |
| `readSavedCoverage(dir?)`                  | Reads and combines the saved coverage in `dir`, and returns it as a `LineCoverage`.          |
| `formatLcov(coverage)`                     | Formats a `LineCoverage` as the contents of an lcov file.                                    |
| `writeLcov(file?, dir?)`                   | Combines the saved coverage in `dir`, and writes it to the lcov file `file`.                 |

`dir` defaults to `node_modules/.cache/zat/coverage`, and `file` to `coverage/z80/lcov.info`.

A `LineCoverage` is a `Map` from each source file's absolute path to a `Map` from line numbers to
the number of times the line was executed. Lines that were loaded but never executed have a count
of 0.

`writeLcov()` only reads saved coverage, so call `saveCoverage()` first, even if all the tests run
in one process.

### Coverage of a single run

The `coverage` in the result of `run()` and `call()` counts how many times the instruction at each
address was executed, for any code, including code from `compile()`. Pass it as the `coverage`
option of later runs to add to it. `zat.showCoverage(prog, coverage)` prints each code line of a
`CompiledProg` with its count, and the percentage of lines executed:

```ts
const prog = zat.compileFile('src/maths.z80');
const { coverage } = zat.call('add_b');
zat.showCoverage(prog, coverage);
```

## Debugging output

These methods print to the console, which can help when a test isn't doing what you expect.

- **`zat.showRegisters()`** prints all the registers and flags.
- **`zat.formatBriefRegisters()`** returns the main registers, the flags, and the word at the top
  of the stack on one line, as a string.
- **`zat.logSteps(on = true)`** prints the registers before each instruction is executed, with
  the name of the symbol at that address, if there is one. `logSteps(false)` turns it off.
- **`zat.dumpMemory(start, length)`** prints memory in hex and ASCII, in rows of 16 bytes aligned
  to multiples of 16. Only complete rows are printed, so use a `start` and `length` that are
  multiples of 16.
- **`prog.dumpList()`** prints the listing of a `CompiledProg`.

## Utility functions

- **`stringToBytes(str)`** returns the character codes of a string as an array of numbers.
- **`hex8(num)`** formats a number as 2 hex digits, e.g. `hex8(10)` is `'0a'`.
- **`hex16(num)`** formats a number as 4 hex digits, e.g. `hex16(10)` is `'000a'`.

## The Z80 emulator

`zat.z80` is the emulator, which is Lawrence Kesteloot's
[z80-emulator](https://github.com/lkesteloot/trs80), copied into zat. It passes the FUSE emulator's
1356 Z80 tests, including the undocumented instructions and flags, and counts T-states accurately.

Most tests only need `zat.z80.regs`. The emulator also has:

- **`pushWord(value)`** and **`popWord()`**, to push and pop the stack.
- **`readByte(address)`**, **`writeByte(address, value)`** and **`readWord(address)`**, which
  access memory through the [memory hooks](#memory-and-io-hooks).
- **`reset()`**, which sets all the registers to 0.
- **`save()`** and **`restore(state)`**, to save and restore the registers.

Use `zat.step()` rather than `zat.z80.step()` to execute an instruction, so that zat can keep track
of `lastInstruction` and interrupts.

`Z80`, `Hal` (the interface the emulator uses to access memory and IO) and `RegisterSet` are
exported, to use the emulator without a `Zat`.

## Using other test frameworks

zat reports failures by throwing errors, which every test framework treats as failures, so it
works with any of them. Only the [`toBeComplete()` matcher](#matchers) is specific to Vitest and
Jest. With other frameworks, check the spy directly:

```ts
assert.ok(ioSpy.allDone());         // node:test, or Mocha with node:assert
expect(ioSpy.allDone()).toBe(true); // Jasmine
expect(ioSpy.allDone()).to.be.true; // Chai
```

For coverage, call `clearSavedCoverage()` before the tests run, `saveCoverage()` at the end of each
process that runs tests, and `writeLcov()` once all the tests have finished:

| Framework  | Before the tests                | After each process                        | After all the tests                   |
|------------|---------------------------------|-------------------------------------------|---------------------------------------|
| Jest       | `globalSetup` module            | `afterAll` in a `setupFilesAfterEnv` file | `globalTeardown` module               |
| Mocha      | `mochaGlobalSetup`              | `afterAll` in `mochaHooks`                | the same hook, after `saveCoverage()` |
| Jasmine    | `beforeAll` in a helper file    | `afterAll` in a helper file               | the same hook, after `saveCoverage()` |
| node:test  | a command before the tests      | `after()` in each test file               | a command after the tests             |

Mocha and Jasmine run all the tests in one process by default. With Mocha's `--parallel`, write
the lcov file in `mochaGlobalTeardown` instead. With any framework, the first and last steps can be
separate commands:

```
node -e "require('zat').clearSavedCoverage()" && node --test && node -e "require('zat').writeLcov()"
```

zat is compiled to CommonJS with type declarations, so any framework can load it. Your test files
need the framework's TypeScript support, e.g. `ts-jest` for Jest, or `tsx` for Mocha. `node:test`
can run TypeScript test files itself, as long as they don't use syntax that needs converting, such
as `enum`s.

zat's cache and coverage files are safe to use from several processes at once, so frameworks that
run tests in parallel worker processes work too.

## Environment variables

| Variable     | Description                                                                          |
|--------------|--------------------------------------------------------------------------------------|
| `ZAT_Z80ASM` | The z80asm command. Defaults to `z88dk.z88dk-z80asm`.                                |
| `ZAT_TMPDIR` | Where temporary files and the cache are kept. Defaults to `node_modules/.cache/zat`. |
| `ZAT_CACHE`  | Set to `0` to turn off caching.                                                      |

## Everything zat exports

| Export                                                  | Kind      | See                                               |
|---------------------------------------------------------|-----------|---------------------------------------------------|
| `Zat`                                                   | class     | This document                                     |
| `RunOptions`, `RunResult`, `Coverage`, `SavedMemory`    | types     | [Running code](#running-code), [Memory and symbols](#memory-and-symbols) |
| `StepResponse`                                          | enum      | [`mockStep()`](#zatmockstepaddr-func)             |
| `InstructionType`                                       | enum      | [`lastInstruction`](#zatlastinstruction)          |
| `Compiler`, `CompiledProg`                              | classes   | [Assembling code](#assembling-code)               |
| `CompilerOptions`, `ListingLine`, `Segment`             | types     | [Assembling code](#assembling-code)               |
| `IoSpy`, `IoSpyError`                                   | classes   | [IoSpy](#iospy)                                   |
| `Port`, `IoValue`, `IoExpectation`                      | types     | [IoSpy](#iospy)                                   |
| `customMatchers`                                        | object    | [Matchers](#matchers)                             |
| `Flags`                                                 | class     | [Registers and flags](#registers-and-flags)       |
| `Flag`                                                  | enum      | [Registers and flags](#registers-and-flags)       |
| `Z80`, `RegisterSet`                                    | classes   | [The Z80 emulator](#the-z80-emulator)             |
| `Hal`                                                   | type      | [The Z80 emulator](#the-z80-emulator)             |
| `getCoverage`, `saveCoverage`, `clearSavedCoverage`, `readSavedCoverage`, `formatLcov`, `writeLcov` | functions | [Coverage](#coverage) |
| `LineCoverage`                                          | type      | [Coverage](#coverage)                             |
| `stringToBytes`, `hex8`, `hex16`                        | functions | [Utility functions](#utility-functions)           |
