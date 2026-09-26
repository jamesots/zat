import { execFileSync } from 'child_process';
import { Assembler } from '../src/zat';

/**
 * Whether z80asm is installed. The tests which use it are skipped if not.
 */
export const z80asmInstalled = (() => {
    try {
        execFileSync(process.env.ZAT_Z80ASM || 'z88dk.z88dk-z80asm', ['-h'], {
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
})();

export const assemblers: Assembler[] = ['maz', 'z80asm'];

/**
 * Whether the tests for an assembler should be skipped
 */
export function skipAssembler(assembler: Assembler) {
    return assembler === 'z80asm' && !z80asmInstalled;
}
