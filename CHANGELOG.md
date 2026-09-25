# CHANGELOG

## v0.2.0 (unreleased)

Breaking changes:

- Code is assembled with z80asm from z88dk instead of maz. z80asm needs to be
  installed. Its syntax differs from maz's in places, e.g. `macro`/`endm`, and
  double quoted strings. An `org` applies to the whole section it's in, so use
  sections to put code at different addresses.
- The Z80.js emulator is replaced with z80-emulator, which passes the FUSE
  tests. Z80.js gave wrong results for some documented instructions, such as
  `rlc (ix+d)` and `add ix,sp`.
- Registers are now in `zat.z80.regs`, e.g. `zat.z80.regs.a`. `zat.z80.af_`
  etc. are now `zat.z80.regs.afPrime` etc.
- Flags are now in `zat.flags` (and `zat.altFlags` for F'), e.g.
  `zat.flags.Z`, instead of `zat.z80.flags`.
- `zat.z80.lastInstruction` is now `zat.lastInstruction`.
- After a HALT, the PC points at the HALT instruction. Calling `run()` without
  a start address continues after it.
- `CompiledProg` has `origin`, `segments` and `lines` instead of `ast` and
  `sources`.
- zat no longer depends on Jasmine, and its own tests use Vitest. `IoSpy`
  throws an `IoSpyError` when IO doesn't happen as expected, instead of
  calling Jasmine's `expect()` and `fail()`. `customMatchers` are now in the
  format used by `expect.extend()` in Vitest and Jest, and `lib/matchers` has
  been removed; see the README for the matcher's type declaration.

New:

- `zat.interrupt()` to trigger a maskable or non-maskable interrupt.
- `zat.step()` to execute a single instruction.

## v0.1.10

Upgraded dependencies

## v0.1.9

Upgraded dependencies, added prettier.