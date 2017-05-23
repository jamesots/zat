import { Z80, Registers, Flags } from './z80/Z80'

const mem = [
    0xc3, 0x04, 0x00, 0xc9, 0x76
]

console.log("z80 test");
const z80 = new Z80({
    mem_read: function(addr) {
        return mem[addr];
    },

    mem_write: function(addr, value) {

    },

    io_read: function(port) {

    },

    io_write: function(port, value) {

    }
});

z80.run_instruction();
const registers = z80.getRegisters();
showRegisters(registers);

function showRegisters(registers: Registers) {
    console.log(
`A: ${hex8(registers.a)}  A': ${hex8(registers.a_prime)}
PC: ${hex16(registers.pc)}`);
}

function hex8(num: number): string {
    let hex = num.toString(16);
    return hex.length == 1 ? '0' + hex : hex;
}

function hex16(num: number): string {
    let hex = num.toString(16);
    return '0000'.substring(0, 4 - hex.length) + hex;
}