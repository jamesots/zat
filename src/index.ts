import { Z80, Flags } from './z80/Z80'

const mem = [
    // 0xc3, 0x04, 0x00, 0xc9, 0x76
    0x3e, 0x12, 0xd3, 0x56
]

console.log("z80 test");
const z80 = new Z80({
    memRead: function(addr) {
        if (addr < mem.length) {
            return mem[addr];
        }
        return 0;
    },

    memWrite: function(addr, value) {
        mem[addr] = value;
    },

    ioRead: function(port) {
        console.log(`IN ${hex8(port)}`);
        return 0;
    },

    ioWrite: function(port, value) {
        console.log(`OUT ${hex16(port)},${hex8(value)}`);
    }
});

z80.runInstruction();
z80.runInstruction();
