import { Z80, Flags } from './z80/Z80';
import { Compiler } from './compiler';
import * as fs from 'fs';

export class Zat {
    public readonly z80: Z80;
    public readonly memory = new Uint8Array(65536);

    /**
     * If ioRead has been set, it will be called when an IO read occurrs.
     */
    public onIoRead: (port: number) => number;

    /**
     * If ioWrite has been set, it will be called when an IO write occurrs.
     */
    public onIoWrite: (port: number, value: number) => void;

    /**
     * If memRead has been set, it will be called when a memory read occurrs.
     * If a number is returned, that value will be used. If undefined is returned,
     * the value from the internal memory will be used.
     */
    public onMemRead: (addr: number) => number;

    /**
     * If memWrite has been set, it will be called when a memory write occurrs.
     * If true is returned then no further action is taken. If false is returned,
     * the value will be written to the internal memory.
     */
    public onMemWrite: (addr: number, value: number) => boolean;

    /**
     * onStep is called before every step. Return true to stop execution.
     */
    public onStep: (pc: number) => boolean;

    /**
     * The symbol table, which is created by the ASM80 compiler. All symbols
     * are in upper case.
     */
    public symbols: {[addr: string]: number} = {};

    constructor() {
        this.z80 = new Z80({
            memRead: addr => this.memRead(addr),
            memWrite: (addr, value) => this.memWrite(addr, value),
            ioRead: port => this.ioRead(port),
            ioWrite: (port, value) => this.ioWrite(port, value)
        });
    }

    private memRead(addr: number): number {
        if (this.onMemRead) {
            let value = this.onMemRead(addr);
            if (value !== undefined) {
                return value;
            }
        }
        return this.memory[addr] || 0;
    }

    private memWrite(addr: number, value: number): void {
        if (this.onMemWrite) {
            if (this.onMemWrite(addr, value)) {
                return;
            }
        }
        this.memory[addr] = value;
    }

    private ioRead(port: number): number {
        if (this.onIoRead) {
            return this.onIoRead(port);
        }
        return 0;
    }

    private ioWrite(port: number, value: number): void {
        if (this.onIoWrite) {
            this.onIoWrite(port, value);
        }
    }

    /**
     * Compile some Z80 code, using the ASM80 compiler.
     * 
     * start is the address of the first byte that should be loaded into
     * memory — you still need to use an 'org' directive in your source code.
     * 
     * E.g. compile("org 5\n ret") would load "0 0 0 0 0 c9" at address 0,
     * compile("org 5\n ret",5) would load "c9" at address 5,
     * compile("ret") would load "c9" at adress 0
     * compile("ret", 5) would load "0" at address 5
     */
    public compile(code: string, start?: number | string) {
        let compiled = new Compiler().compile(code);
        for (const symbol in compiled.symbols) {
            this.symbols[symbol] = compiled.symbols[symbol];
        }
        if (start !== undefined) {
            start = this.getAddress(start);
            this.load(compiled.data.subarray(start), start);
        } else {
            this.load(compiled.data);
        }
    }

    /**
     * Compile some Z80 code from a file, using the ASM80 compiler.
     */
    public compileFile(filename: string) {
        let buffer = fs.readFileSync(filename);
        return this.compile(buffer.toString());
    }

    /**
     * Load some values into memory
     */
    public load(mem: number[] | Uint8Array, start = 0) {
        this.memory.set(mem, start);
    }

    public getAddress(addr: number | string) {
        if (typeof addr === 'string') {
            return this.symbols[addr.toUpperCase()];
        }
        return addr;
    }

    /**
     * Run until a HALT is encountered, or number of instructions executed is
     * more than runOptions.steps, or instruction at runOptions.breakAt is
     * reached.
     * 
     * Returns the number of instructions executed and the number of T-states
     */
    public run(start?: number | string, runOptions?: RunOptions) {
        runOptions = runOptions || {};
        const startSp = this.z80.sp;
        if (start !== undefined) {
            this.z80.pc = this.getAddress(start);
        }
        let steps = 10000000;
        if (runOptions.steps !== undefined) {
            steps = runOptions.steps;
        } 
        let breakAt = undefined;
        if (runOptions.breakAt !== undefined) {
            breakAt = this.getAddress(runOptions.breakAt);
        }

        this.z80.halted = false;
        let count = 0;
        let tStates = 0;
        while (!this.z80.halted && (count < steps) && (this.z80.pc !== breakAt)
            && !(this.onStep && this.onStep(this.z80.pc))
            && !(runOptions.call && this.z80.sp === startSp + 2)) {
            tStates +=this.z80.runInstruction();
            count++;
        }
        return [count, tStates];
    }

    public showRegisters() {
        console.log(
`AF: ${hex16(this.z80.af)}  AF': ${hex16(this.z80.af_)}
BC: ${hex16(this.z80.bc)}  BC': ${hex16(this.z80.bc_)}
DE: ${hex16(this.z80.de)}  DE': ${hex16(this.z80.de_)}
HL: ${hex16(this.z80.hl)}  HL': ${hex16(this.z80.hl_)}
IX: ${hex16(this.z80.ix)}   IY: ${hex16(this.z80.iy)}
PC: ${hex16(this.z80.pc)}   SP: ${hex16(this.z80.sp)}
I: ${hex16(this.z80.i)}    R: ${hex16(this.z80.r)}
    S Z Y H X P N C
F: ${this.z80.flags.S} ${this.z80.flags.Z} ${this.z80.flags.Y} ${this.z80.flags.H} ${this.z80.flags.X} ${this.z80.flags.P} ${this.z80.flags.N} ${this.z80.flags.C}
F': ${this.z80.flags_.S} ${this.z80.flags_.Z} ${this.z80.flags_.Y} ${this.z80.flags_.H} ${this.z80.flags_.X} ${this.z80.flags_.P} ${this.z80.flags_.N} ${this.z80.flags_.C}
`);
    }
}

export function hex8(num: number): string {
    let hex = num.toString(16);
    return hex.length == 1 ? '0' + hex : hex;
}

export function hex16(num: number): string {
    let hex = num.toString(16);
    return '0000'.substring(0, 4 - hex.length) + hex;
}

export function stringToBytes(str: string): number[] {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i));
    }
    return bytes;
}

export interface RunOptions {
    steps?: number;
    breakAt?: number | string;
    call?: boolean;
}