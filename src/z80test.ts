import { Z80, Registers, Flags } from './z80/Z80';
import { Compiler } from './compiler';

export class Zat {
    z80: Z80;
    memory: number[] = [];
    public ioRead: (port: number) => number;
    public ioWrite: (port: number, value: number) => void;
    public memRead: (addr: number) => number;
    public memWrite: (addr: number, value: number) => boolean;

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
        let memory = new Compiler().compile(code);
        this.load(Array.from(memory));
    }

    public load(mem: number[]) {
        this.memory.splice(0, mem.length, ...mem);
    }

    get registers(): Registers {
        return this.z80.getRegisters();
    }

    public run(start?: number, steps?: number) {
        if (start !== undefined) {
            let reg = this.z80.getRegisters();
            reg.pc = start;
            this.z80.setRegisters(reg);
        }
        if (steps) {
            for (let i = 0; i < steps; i++) {
                this.z80.run_instruction();
            }
            return steps;
        } else {
            this.z80.halted = false;
            let count = 0;
            while (!this.z80.halted) {
                this.z80.run_instruction();
                count++;
            }
            return count;
        }
    }
}