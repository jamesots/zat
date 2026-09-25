Vendored code
=============

`z80-emulator` and `z80-base` are copied from Lawrence Kesteloot's
[trs80](https://github.com/lkesteloot/trs80) repository, at commit
`25a156e56f3ede9d02b3c68157425d07a657c876`:

 * `packages/z80-emulator/src` → `z80-emulator`
 * `packages/z80-base/src` → `z80-base`

They are MIT licensed; see the `LICENSE` file in each directory.

They're copied rather than installed from npm because the packages are no
longer published there: the last npm release is from 2021, and the
upstream code has had fixes since.

`Decode.ts` is generated upstream by `opcodes/GenerateOpcodes.ts`, so
fixes to it should ideally be made there too.

Local modifications
-------------------

The files were first committed unchanged, and each modification was then
committed separately, so `git log -p src/vendor` shows exactly what was
changed.

 * The `"z80-base"` package imports in `z80-emulator` are changed to import
   from `../z80-base/index.js`.
 * `decodeED` in `Decode.ts` no longer logs to the console for undefined ED
   opcodes, which are treated as NOPs as before.
