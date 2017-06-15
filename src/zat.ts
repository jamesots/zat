import { Z80, Flags, InstructionType } from './z80/Z80';
export { Z80, Flags, InstructionType } from './z80/Z80';
import { Compiler, CompiledProg } from './compiler';
export { Compiler, CompiledProg } from './compiler';
export { IoSpy } from './io_spies';
import { StepMock } from './step_mocks';
export { customMatchers } from './custom_matchers';
import * as fs from 'fs';

export class Zat {
    public readonly z80: Z80;
    public readonly memory = new Uint8Array(65536);
    private stepMock = new StepMock(this);
    private logging = false;
    private breakpoints: {[addr: number]: true} = {};

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
     * The symbol table, which is created by the ASM80 compiler. All symbols
     * are in upper case.
     */
    public symbols: {[addr: string]: number} = {};

    /**
     * When using call(), set the stack pointer to this value before starting, if set
     */
    public defaultCallSp: number | string;

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

    public getMemory(start: number | string, length: number): number[] {
        start = this.getAddress(start);
        return Array.from(this.memory.subarray(start, start + length));
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
        this.loadProg(compiled, start);
        return compiled;
    }

    public loadProg(prog: CompiledProg, start?: number | string) {
        for (const symbol in prog.symbols) {
            this.symbols[symbol] = prog.symbols[symbol];
        }
        if (start !== undefined) {
            start = this.getAddress(start);
            this.load(prog.data.subarray(start), start);
        } else {
            this.load(prog.data);
        }
    }

    /**
     * Compile some Z80 code from a file, using the ASM80 compiler.
     */
    public compileFile(filename: string, start?: number | string) {
        let compiled = new Compiler().compileFile(filename);
        this.loadProg(compiled, start);
    }

    /**
     * Load some values into memory
     */
    public load(mem: number[] | Uint8Array | string, start: number | string = 0) {
        if (typeof mem === 'string') {
            mem = stringToBytes(mem);
        }
        this.memory.set(mem, this.getAddress(start));
    }

    public getAddress(addr: number | string) {
        if (typeof addr === 'string') {
            const address = this.symbols[addr.toUpperCase()];
            if (typeof address === 'undefined') {
                throw `Symbol "${addr}" not found`;
            }
            return address;
        }
        return addr;
    }

    public getSymbol(addr: number) {
        for (const symbol in this.symbols) {
            if (this.symbols[symbol] === addr) {
                return symbol;
            }
        }
        return '';
    }

    /**
     * Calls run, with 'call' set to true in runOptions.
     */
    public call(start?: number | string, runOptions?: RunOptions) {
        runOptions = runOptions || {};
        runOptions.call = true;
        const sp = runOptions.sp || this.defaultCallSp;
        if (typeof sp !== 'undefined') {
            this.z80.sp = this.getAddress(sp);
        }
        return this.run(start, runOptions);
    }

    /**
     * Run until a HALT is encountered, or number of instructions executed is
     * more than runOptions.steps, or instruction at runOptions.breakAt is
     * reached.
     * 
     * If 'call' is true, it will run until the stack pointer is 2 more than it
     * started out at. This may happen as a result of popping something of the
     * stack rather than a return statement.
     * 
     * Returns the number of instructions executed and the number of T-states
     */
    public run(start?: number | string, runOptions?: RunOptions) {
        runOptions = runOptions || {};
        let startSp = this.z80.sp + 2;
        if (startSp >= 65536) {
            startSp = startSp - 65536;
        }
        if (start !== undefined) {
            this.z80.pc = this.getAddress(start);
        }
        let steps = 10000000;
        if (runOptions.steps !== undefined) {
            steps = runOptions.steps;
        }
        let coverage;
        if (runOptions.coverage !== undefined) {
            coverage = runOptions.coverage;
        } else {
            coverage = {};
        }

        this.z80.halted = false;
        let count = 0;
        let tStates = 0;
        let stepResponse: StepResponse = StepResponse.RUN;
        while (!this.z80.halted && (count < steps) 
            && !this.breakpoints[this.z80.pc]
            && !((stepResponse = this.stepMock.onStep(this.z80.pc)) === StepResponse.BREAK)
            && !(runOptions.call && this.z80.sp === startSp && this.z80.lastInstruction === InstructionType.RET)) {

            if (this.logging) {
                console.log(`${this.formatBriefRegisters()} ${this.getSymbol(this.z80.pc)}`);
            }
            if (stepResponse !== StepResponse.SKIP) {
                if (coverage[this.z80.pc] === undefined) {
                    coverage[this.z80.pc] = 0;
                }
                coverage[this.z80.pc]++;
                tStates += this.z80.runInstruction();
                count++;
            }
            stepResponse = StepResponse.RUN;
        }
        return [count, tStates, coverage];
    }

    saveMemory() {
        const savedSymbols = {};
        for (const symbol in this.symbols) {
            savedSymbols[symbol] = this.symbols[symbol];
        }
        return {
            memory: new Uint8Array(this.memory),
            symbols: savedSymbols
        }
    }

    loadMemory(savedMemory) {
        this.memory.set(savedMemory.memory);
        this.symbols = {};
        for (const symbol in savedMemory.symbols) {
            this.symbols[symbol] = savedMemory.symbols[symbol];
        }
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

    public formatBriefRegisters() {
        const flags = `${this.z80.flags.S == 1 ? 'S' : '.'}${this.z80.flags.Z == 1 ? 'Z' : '.'}${this.z80.flags.H == 1 ? 'H' : '.'}${this.z80.flags.P == 1 ? 'P' : '.'}${this.z80.flags.N == 1 ? 'N' : '.'}${this.z80.flags.C == 1 ? 'C' : '.'}`;
        return `AF:${hex16(this.z80.af)} ${flags} BC:${hex16(this.z80.bc)} DE:${hex16(this.z80.de)} HL:${hex16(this.z80.hl)} IX:${hex16(this.z80.ix)} IY:${hex16(this.z80.iy)} SP:${hex16(this.z80.sp)} (SP):${hex8(this.memory[this.z80.sp + 1])}${hex8(this.memory[this.z80.sp])} PC:${hex16(this.z80.pc)}`;
    }

    public dumpMemory(start: number, length: number) {
        let line = '';
        let ascii = '';
        for (let addr = start; addr < start + length; addr++) {
            line += `${hex8(this.memory[addr])} `;
            if (this.memory[addr] > 31 && this.memory[addr] < 127) {
                ascii += String.fromCharCode(this.memory[addr]);
            } else {
                ascii += '·';
            }
            if ((addr + 1) % 16 === 0) {
                line = ' '.repeat(48 - line.length) + line;
                ascii = ' '.repeat(16 - ascii.length) + ascii;
                line = hex16(addr - 15) + ' ' + line;
                console.log(`${line} ${ascii}`);
                line = '';
                ascii = '';
            }
        }
    }

    /**
     * Every time addr is called, func will be executed, and then
     * control will return to wherever it was called from.
     * 
     * func will only be executed as a result of a CALL or RST, not
     * if execution passes to the address in any other way.
     */
    public mockCall(addr: number | string, func: () => void) {
        this.stepMock.setFakeCall(addr, func);
    }

    /**
     * When addr is reached, and before the instruction at addr is
     * executed, stop execution.
     */
    public setBreakpoint(addr: number | string) {
        this.breakpoints[this.getAddress(addr)] = true;
    }

    public clearBreakpoint(addr: number | string) {
        delete this.breakpoints[this.getAddress(addr)];
    }

    /**
     * Log the registers at each step of execution. The register
     * values are logged before the instruction is executed.
     */
    public logSteps(on = true) {
        this.logging = on;
    }

    /**
     * Call func before the instruction at addr is executed. func should
     * return RUN, BREAK or SKIP.
     * 
     * If RUN is returned, execution continues as usual.
     * If BREAK is returned, execution stops.
     * If SKIP is returned, execution continues, but the current instruction
     * is not executed. Note that if func doesn't change the PC then 
     * func will immediately be called over an over again.
     */
    public mockStep(addr: number | string, func: () => StepResponse) {
        this.stepMock.setOnStep(addr, func);
    }

    /**
     * Like mockStep, except that func is executed for every step.
     */
    public mockAllSteps(func: (pc) => StepResponse) {
        this.stepMock.setOnAllSteps(func);
    }

    public showCoverage(prog: CompiledProg, coverage: Coverage) {
        let lines = 0;
        let coveredLines = 0;
        for (const line of prog.ast) {
            lines++;
            let count = 0;
            if (coverage[line.addr] > 0) {
                count = coverage[line.addr];
                coveredLines++;
            }
            console.log(`${count}  ${line.numline}: ${line.line}`);
        }
        console.log(`${(coveredLines/lines*100).toFixed(1)}% covered`);
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

export interface Coverage {
    [address: number]: number;
}

export interface RunOptions {
    steps?: number;
    call?: boolean;
    sp?: number | string;
    coverage?: Coverage
}

export enum StepResponse {
    RUN,
    BREAK,
    SKIP
}
