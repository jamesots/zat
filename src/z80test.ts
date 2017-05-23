import { Z80, Registers, Flags } from './z80/Z80';
import { Compiler } from './compiler';
import * as fs from 'fs';

export class Zat {
    z80: Z80;
    memory: number[] = [];
    public ioRead: (port: number) => number;
    public ioWrite: (port: number, value: number) => void;
    public memRead: (addr: number) => number;
    public memWrite: (addr: number, value: number) => boolean;

    private symbols: {[addr: string]: number};

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

    public compile(code: string) {
        let compiled = new Compiler().compile(code);
        this.symbols = compiled.symbols;
        this.load(Array.from(compiled.data));
    }

    public compileFile(filename) {
        let buffer = fs.readFileSync(filename);
        return this.compile(buffer.toString());
    }

    public load(mem: number[]) {
        this.memory.splice(0, mem.length, ...mem);
    }

    get registers(): Registers {
        return this.z80.getRegisters();
    }

    /**
     * Run until a HALT is encountered, or number of instructions executed is
     * more than runOptions.steps, or instruction at runOptions.breakAt is
     * reached.
     */
    public run(start?: number | string, runOptions?: RunOptions) {
        if (start !== undefined) {
            if (typeof start === 'string') {
                this.z80.pc = this.symbols[start.toUpperCase()];
            } else {
                this.z80.pc = start;
            }
        }
        let steps = 10000000;
        if (runOptions && runOptions.steps !== undefined) {
            steps = runOptions.steps;
        } 
        let breakAt = undefined;
        if (runOptions && runOptions.breakAt !== undefined) {
            if (typeof runOptions.breakAt === 'string') {
                breakAt = this.symbols[runOptions.breakAt.toUpperCase()];
            } else {
                breakAt = runOptions.breakAt
            }
        }

        this.z80.halted = false;
        let count = 0;
        while (!this.z80.halted && (count < steps) && (this.z80.pc !== breakAt)) {
            this.z80.run_instruction();
            count++;
        }
        return count;
    }
}

export interface RunOptions {
    steps?: number;
    breakAt?: number | string;
}