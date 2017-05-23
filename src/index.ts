import { Z80, Registers, Flags } from './z80/Z80'

const mem = [
    // 0xc3, 0x04, 0x00, 0xc9, 0x76
    0x3e, 0x12, 0xd3, 0x56
]

console.log("z80 test");
const z80 = new Z80({
    mem_read: function(addr) {
        if (addr < mem.length) {
            return mem[addr];
        }
        return 0;
    },

    mem_write: function(addr, value) {
        mem[addr] = value;
    },

    io_read: function(port) {
        console.log(`IN ${hex8(port)}`);
        return 0;
    },

    io_write: function(port, value) {
        console.log(`OUT ${hex16(port)},${hex8(value)}`);
    }
});

z80.run_instruction();
z80.run_instruction();
const registers = z80.getRegisters();
showRegisters(registers);

function showRegisters(registers: Registers) {
    console.log(
`AF: ${hex8(registers.a)}${hex8(flagsToNumber(registers.flags))}  AF': ${hex8(registers.a_prime)}${hex8(flagsToNumber(registers.flags_prime))}
BC: ${hex8(registers.b)}${hex8(registers.c)}  BC': ${hex8(registers.b_prime)}${hex8(registers.c_prime)}
DE: ${hex8(registers.d)}${hex8(registers.e)}  DE': ${hex8(registers.d_prime)}${hex8(registers.e_prime)}
HL: ${hex8(registers.h)}${hex8(registers.l)}  HL': ${hex8(registers.h_prime)}${hex8(registers.l_prime)}
IX: ${hex16(registers.ix)}   IY: ${hex16(registers.iy)}
PC: ${hex16(registers.pc)}   SP: ${hex16(registers.sp)}
 I: ${hex16(registers.i)}    R: ${hex16(registers.r)}
    S Z Y H X P N C
 F: ${registers.flags.S} ${registers.flags.Z} ${registers.flags.Y} ${registers.flags.H} ${registers.flags.X} ${registers.flags.P} ${registers.flags.N} ${registers.flags.C}
F': ${registers.flags_prime.S} ${registers.flags_prime.Z} ${registers.flags_prime.Y} ${registers.flags_prime.H} ${registers.flags_prime.X} ${registers.flags_prime.P} ${registers.flags_prime.N} ${registers.flags_prime.C}
`);
}

function hex8(num: number): string {
    let hex = num.toString(16);
    return hex.length == 1 ? '0' + hex : hex;
}

function hex16(num: number): string {
    let hex = num.toString(16);
    return '0000'.substring(0, 4 - hex.length) + hex;
}

function flagsToNumber(flags: Flags): number {
    return flags.S << 7
        | flags.Z << 6
        | flags.Y << 5
        | flags.H << 4
        | flags.X << 3
        | flags.P << 2
        | flags.N << 1
        | flags.C << 0
}