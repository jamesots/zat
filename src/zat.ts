import { Z80, Registers, Flags } from './z80/Z80';
import { Compiler } from './compiler';
import * as fs from 'fs';

export class Zat {
    public z80: Z80;
    public memory = new Uint8Array(65536);

    /**
     * If ioRead has been set, it will be called when an IO read occurrs.
     */
    public ioRead: (port: number) => number;

    /**
     * If ioWrite has been set, it will be called when an IO write occurrs.
     */
    public ioWrite: (port: number, value: number) => void;

    /**
     * If memRead has been set, it will be called when a memory read occurrs.
     * If a number is returned, that value will be used. If undefined is returned,
     * the value from the internal memory will be used.
     */
    public memRead: (addr: number) => number;

    /**
     * If memWrite has been set, it will be called when a memory write occurrs.
     * If true is returned then no further action is taken. If false is returned,
     * the value will be written to the internal memory.
     */
    public memWrite: (addr: number, value: number) => boolean;

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
            mem_read: addr => this.onMemRead(addr),
            mem_write: (addr, value) => this.onMemWrite(addr, value),
            io_read: port => this.onIoRead(port),
            io_write: (port, value) => this.onIoWrite(port, value)
        });
    }

    private onMemRead(addr: number): number {
        if (this.memRead) {
            let value = this.memRead(addr);
            if (value !== undefined) {
                return value;
            }
        }
        return this.memory[addr] || 0;
    }

    private onMemWrite(addr: number, value: number): void {
        if (this.memWrite) {
            if (this.memWrite(addr, value)) {
                return;
            }
        }
        this.memory[addr] = value;
    }

    private onIoRead(port: number): number {
        if (this.ioRead) {
            return this.ioRead(port);
        }
        return 0;
    }

    private onIoWrite(port: number, value: number): void {
        if (this.ioWrite) {
            this.ioWrite(port, value);
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
    public compile(code: string, start?: number) {
        let compiled = new Compiler().compile(code);
        for (const symbol in compiled.symbols) {
            this.symbols[symbol] = compiled.symbols[symbol];
        }
        if (start !== undefined) {
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

    /**
     * Get the current values of the Z80 registers
     */
    get registers(): Registers {
        return this.z80.getRegisters();
    }

    /**
     * Set the current values of the Z80 registers
     */
    set registers(registers: Registers) {
        this.z80.setRegisters(registers);
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
     * Returns the number of instructions executed.
     */
    public run(start?: number | string, runOptions?: RunOptions) {
        if (start !== undefined) {
            this.z80.pc = this.getAddress(start);
        }
        let steps = 10000000;
        if (runOptions && runOptions.steps !== undefined) {
            steps = runOptions.steps;
        } 
        let breakAt = undefined;
        if (runOptions && runOptions.breakAt !== undefined) {
            breakAt = this.getAddress(runOptions.breakAt);
        }

        this.z80.halted = false;
        let count = 0;
        let tStates = 0;
        while (!this.z80.halted && (count < steps) && (this.z80.pc !== breakAt)
            && !(this.onStep && this.onStep(this.z80.pc))) {
            tStates +=this.z80.run_instruction();
            count++;
        }
        return [count, tStates];
    }
}

export interface RunOptions {
    steps?: number;
    breakAt?: number | string;
}