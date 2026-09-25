import { Z80, Hal } from './vendor/z80-emulator';
export { Z80, Hal } from './vendor/z80-emulator';
export { Flag, RegisterSet } from './vendor/z80-base';
import { Flags } from './flags';
export { Flags } from './flags';
import { InstructionType, classifyInstruction } from './instruction_type';
export { InstructionType } from './instruction_type';
import { Compiler, CompiledProg } from './compiler';
export {
    Compiler,
    CompiledProg,
    CompilerOptions,
    ListingLine,
    Segment,
} from './compiler';
export { IoSpy, IoSpyError, Port, IoValue, IoExpectation } from './io_spies';
import { StepMock } from './step_mocks';
export { customMatchers } from './custom_matchers';
import { addLine, isCoverable, lineExecuted } from './coverage';
export {
    LineCoverage,
    getCoverage,
    saveCoverage,
    clearSavedCoverage,
    readSavedCoverage,
    formatLcov,
    writeLcov,
} from './coverage';
import * as path from 'path';

export class Zat {
    public readonly z80: Z80;
    public readonly memory = new Uint8Array(65536);

    /**
     * The source file and line of the instruction at each address, for
     * coverage.
     */
    private sourceLines = new Map<number, { file: string; line: number }>();

    /**
     * The flags in the F register, e.g. zat.flags.Z
     */
    public readonly flags = new Flags(
        () => this.z80.regs.f,
        (f) => (this.z80.regs.f = f)
    );

    /**
     * The flags in the alternate F register
     */
    public readonly altFlags = new Flags(
        () => this.z80.regs.afPrime & 0xff,
        (f) => (this.z80.regs.afPrime = (this.z80.regs.afPrime & 0xff00) | f)
    );

    /**
     * The kind of the last instruction executed. Only CALLs and RETs which
     * were taken count as CALL or RET.
     */
    public lastInstruction = InstructionType.OTHER;

    private hal: Hal;
    /** The first bytes read during the current instruction */
    private fetched: number[] = [];
    /**
     * Whether the last instruction was EI. A maskable interrupt isn't
     * accepted until after the instruction following EI.
     */
    private eiDelay = false;
    private stepMock = new StepMock(this);
    private logging = false;
    private breakpoints: { [addr: number]: true } = {};

    /**
     * If ioRead has been set, it will be called when an IO read occurrs.
     */
    public onIoRead?: (port: number) => number;

    /**
     * If ioWrite has been set, it will be called when an IO write occurrs.
     */
    public onIoWrite?: (port: number, value: number) => void;

    /**
     * If memRead has been set, it will be called when a memory read occurrs.
     * If a number is returned, that value will be used. If undefined is returned,
     * the value from the internal memory will be used.
     */
    public onMemRead?: (addr: number) => number | undefined;

    /**
     * If memWrite has been set, it will be called when a memory write occurrs.
     * If true is returned then no further action is taken. If false is returned,
     * the value will be written to the internal memory.
     */
    public onMemWrite?: (addr: number, value: number) => boolean;

    /**
     * The symbol table, which is created by z80asm. Symbols are
     * case-sensitive, as they are in z80asm.
     */
    public symbols: { [addr: string]: number } = {};

    /**
     * When using call(), set the stack pointer to this value before starting, if set
     */
    public defaultCallSp?: number | string;

    constructor() {
        this.hal = {
            tStateCount: 0,
            readMemory: (addr) => {
                const value = this.memRead(addr);
                if (this.fetched.length < 2) {
                    this.fetched.push(value);
                }
                return value;
            },
            writeMemory: (addr, value) => this.memWrite(addr, value),
            contendMemory: () => {},
            readPort: (port) => this.ioRead(port),
            writePort: (port, value) => this.ioWrite(port, value),
            contendPort: () => {},
        };
        this.z80 = new Z80(this.hal);
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
     * Compile some Z80 code, using z80asm.
     *
     * The code is loaded at its origin (set with an 'org' directive, or 0 if
     * there isn't one), unless loadAt is given, in which case the first byte
     * is loaded at loadAt.
     *
     * E.g. compile("org 5\n ret") would load "c9" at address 5,
     * compile("ret") would load "c9" at address 0,
     * compile("org 5\n ret", 10) would load "c9" at address 10
     *
     * Note that z80asm applies an 'org' to the whole section it's in. To put
     * code at more than one address, put each part in its own section.
     */
    public compile(code: string, loadAt?: number | string) {
        let compiled = new Compiler().compile(code);
        this.loadProg(compiled, loadAt);
        return compiled;
    }

    /**
     * Load a compiled program at its origin, or at loadAt if it's given.
     */
    public loadProg(prog: CompiledProg, loadAt?: number | string) {
        for (const symbol in prog.symbols) {
            this.symbols[symbol] = prog.symbols[symbol];
        }
        let offset = 0;
        if (loadAt !== undefined) {
            offset = this.getAddress(loadAt) - prog.origin;
            this.load(prog.data, prog.origin + offset);
        } else {
            for (const segment of prog.segments) {
                this.load(segment.data, segment.address);
            }
        }
        for (const line of prog.lines) {
            if (isCoverable(line)) {
                const file = path.resolve(line.file);
                addLine(file, line.line);
                this.sourceLines.set((line.address + offset) & 0xffff, {
                    file,
                    line: line.line,
                });
            }
        }
    }

    /**
     * Compile some Z80 code from a file, using z80asm, and load it at its
     * origin, or at loadAt if it's given.
     */
    public compileFile(filename: string, loadAt?: number | string) {
        let compiled = new Compiler().compileFile(filename);
        this.loadProg(compiled, loadAt);
        return compiled;
    }

    /**
     * Load some values into memory
     */
    public load(
        mem: number[] | Uint8Array | string,
        loadAt: number | string = 0
    ) {
        if (typeof mem === 'string') {
            mem = stringToBytes(mem);
        }
        const address = this.getAddress(loadAt);
        this.memory.set(mem, address);
        // The code which was there, if any, has been replaced
        if (this.sourceLines.size > 0) {
            for (let i = 0; i < mem.length; i++) {
                this.sourceLines.delete(address + i);
            }
        }
    }

    public getAddress(addr: number | string): number {
        if (typeof addr === 'string') {
            const address = this.symbols[addr];
            if (address === undefined) {
                const other = Object.keys(this.symbols).find(
                    (symbol) => symbol.toLowerCase() === addr.toLowerCase()
                );
                throw new Error(
                    `Symbol "${addr}" not found${
                        other !== undefined ? ` (did you mean "${other}"?)` : ''
                    }`
                );
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
     * Calls run, with 'call' set to true in runOptions, so that it stops
     * when the routine returns.
     *
     * The stack pointer is set to runOptions.sp, or defaultCallSp, if either
     * is set. Then runOptions.returnAddress, if it's set, is pushed onto the
     * stack, as a CALL instruction would, so that the PC is set to it when
     * the routine returns.
     */
    public call(start?: number | string, runOptions: RunOptions = {}) {
        const sp = runOptions.sp ?? this.defaultCallSp;
        if (sp !== undefined) {
            this.z80.regs.sp = this.getAddress(sp);
        }
        if (runOptions.returnAddress !== undefined) {
            this.z80.pushWord(this.getAddress(runOptions.returnAddress));
        }
        return this.run(start, { ...runOptions, call: true });
    }

    /**
     * Interrupt the CPU. A maskable interrupt is ignored if interrupts are
     * disabled. In interrupt mode 2, the byte from the data bus is $FF.
     *
     * Returns the number of T-states the interrupt took, which is 0 if it
     * was ignored.
     */
    public interrupt(nonMaskable = false): number {
        const sp = this.z80.regs.sp;
        const tStates = this.hal.tStateCount;
        if (nonMaskable) {
            this.z80.nonMaskableInterrupt();
        } else {
            this.z80.maskableInterrupt();
        }
        if (this.z80.regs.sp !== sp) {
            this.lastInstruction = InstructionType.INT;
        }
        return this.hal.tStateCount - tStates;
    }

    /**
     * Execute one instruction, and return the number of T-states it took.
     */
    public step(): number {
        const sp = this.z80.regs.sp;
        const tStates = this.hal.tStateCount;
        this.fetched = [];
        this.z80.step();
        this.eiDelay = this.fetched[0] === 0xfb;
        this.lastInstruction = classifyInstruction(
            this.fetched,
            sp,
            this.z80.regs.sp
        );
        return this.hal.tStateCount - tStates;
    }

    /**
     * Run until a HALT is encountered, or number of instructions executed is
     * more than runOptions.steps, or instruction at runOptions.breakAt is
     * reached.
     *
     * If runOptions.interruptEvery is set, an interrupt is raised every that
     * many T-states, starting that many T-states after the run starts. It's
     * a maskable interrupt, unless runOptions.interruptNonMaskable is true.
     * A maskable interrupt is missed if interrupts are disabled when it's
     * raised, but if the last instruction was EI, it's accepted after the
     * next instruction. After a HALT, the CPU waits for the next interrupt,
     * unless it would be missed.
     *
     * If 'call' is true, it will run until the stack pointer is 2 more than it
     * started out at. This may happen as a result of popping something of the
     * stack rather than a return statement.
     *
     * After a HALT, the PC is left pointing at the HALT instruction. If run
     * is then called without a start address, execution continues after
     * the HALT.
     *
     * Returns the number of instructions executed, the number of T-states,
     * the number of interrupts accepted, and the coverage.
     */
    public run(start?: number | string, runOptions?: RunOptions): RunResult {
        runOptions = runOptions || {};
        const regs = this.z80.regs;
        const startSp = (regs.sp + 2) & 0xffff;
        if (regs.halted) {
            regs.halted = 0;
            if (start === undefined) {
                regs.pc = (regs.pc + 1) & 0xffff;
            }
        }
        if (start !== undefined) {
            regs.pc = this.getAddress(start);
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

        const every = runOptions.interruptEvery;
        if (every !== undefined && !(every > 0)) {
            throw new Error('interruptEvery must be more than 0');
        }
        const nonMaskable = runOptions.interruptNonMaskable ?? false;
        let nextInterrupt = every ?? Infinity;
        let interrupts = 0;

        let count = 0;
        let tStates = 0;
        let stepResponse: StepResponse = StepResponse.RUN;
        while (true) {
            if (
                every !== undefined &&
                (tStates >= nextInterrupt || regs.halted)
            ) {
                const accepted =
                    nonMaskable || (regs.iff1 !== 0 && !this.eiDelay);
                if (regs.halted && tStates < nextInterrupt) {
                    if (!accepted) {
                        // Halted with interrupts disabled, so stuck
                        break;
                    }
                    // Wait for the interrupt
                    tStates = nextInterrupt;
                }
                if (accepted) {
                    tStates += this.interrupt(nonMaskable);
                    interrupts++;
                }
                // The interrupt is missed if interrupts are disabled, but
                // is accepted after the instruction following EI
                if (accepted || !this.eiDelay) {
                    while (nextInterrupt <= tStates) {
                        nextInterrupt += every;
                    }
                }
            }
            if (
                regs.halted ||
                count >= steps ||
                this.breakpoints[regs.pc] ||
                (stepResponse = this.stepMock.onStep(regs.pc)) ===
                    StepResponse.BREAK ||
                (runOptions.call &&
                    regs.sp === startSp &&
                    this.lastInstruction === InstructionType.RET)
            ) {
                break;
            }
            const pc = regs.pc;
            if (this.logging) {
                console.log(
                    `${this.formatBriefRegisters()} ${this.getSymbol(pc)}`
                );
            }
            if (stepResponse !== StepResponse.SKIP) {
                if (coverage[pc] === undefined) {
                    coverage[pc] = 0;
                }
                coverage[pc]++;
                const source = this.sourceLines.get(pc);
                if (source) {
                    lineExecuted(source.file, source.line);
                }
                tStates += this.step();
                count++;
            }
            stepResponse = StepResponse.RUN;
        }
        return { instructions: count, tStates, interrupts, coverage };
    }

    public saveMemory(): SavedMemory {
        return {
            memory: new Uint8Array(this.memory),
            symbols: { ...this.symbols },
        };
    }

    public loadMemory(savedMemory: SavedMemory) {
        this.memory.set(savedMemory.memory);
        this.symbols = { ...savedMemory.symbols };
    }

    public showRegisters() {
        const regs = this.z80.regs;
        console.log(
            `AF: ${hex16(regs.af)}  AF': ${hex16(regs.afPrime)}
BC: ${hex16(regs.bc)}  BC': ${hex16(regs.bcPrime)}
DE: ${hex16(regs.de)}  DE': ${hex16(regs.dePrime)}
HL: ${hex16(regs.hl)}  HL': ${hex16(regs.hlPrime)}
IX: ${hex16(regs.ix)}   IY: ${hex16(regs.iy)}
PC: ${hex16(regs.pc)}   SP: ${hex16(regs.sp)}
I: ${hex8(regs.i)}      R: ${hex8(regs.r)}
F:  ${this.flags}
F': ${this.altFlags}
`
        );
    }

    public formatBriefRegisters() {
        const regs = this.z80.regs;
        const sp = regs.sp;
        return `AF:${hex16(regs.af)} ${this.flags} BC:${hex16(
            regs.bc
        )} DE:${hex16(regs.de)} HL:${hex16(regs.hl)} IX:${hex16(
            regs.ix
        )} IY:${hex16(regs.iy)} SP:${hex16(sp)} (SP):${hex8(
            this.memory[(sp + 1) & 0xffff]
        )}${hex8(this.memory[sp])} PC:${hex16(regs.pc)}`;
    }

    /**
     * Format memory in hex and ASCII, in rows of 16 bytes which start at
     * multiples of 16. Bytes before start or after the end in the first and
     * last rows are left blank.
     */
    public formatMemory(start: number | string, length: number): string {
        const first = this.getAddress(start);
        const end = Math.min(first + length, 0x10000);
        const rows = [];
        for (let row = first & ~0xf; row < end; row += 16) {
            let hex = '';
            let ascii = '';
            for (let addr = row; addr < row + 16; addr++) {
                if (addr < first || addr >= end) {
                    hex += '   ';
                    ascii += ' ';
                } else {
                    const value = this.memory[addr];
                    hex += `${hex8(value)} `;
                    ascii +=
                        value > 31 && value < 127
                            ? String.fromCharCode(value)
                            : '·';
                }
            }
            rows.push(`${hex16(row)} ${hex} ${ascii}`.trimEnd());
        }
        return rows.join('\n');
    }

    /**
     * Print memory in hex and ASCII. See formatMemory.
     */
    public dumpMemory(start: number | string, length: number) {
        console.log(this.formatMemory(start, length));
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
    public mockAllSteps(func: (pc: number) => StepResponse) {
        this.stepMock.setOnAllSteps(func);
    }

    public showCoverage(prog: CompiledProg, coverage: Coverage) {
        let lines = 0;
        let coveredLines = 0;
        for (const line of prog.lines.filter((line) => !line.data)) {
            lines++;
            let count = 0;
            if (coverage[line.address] > 0) {
                count = coverage[line.address];
                coveredLines++;
            }
            console.log(`${count}  ${line.line}: ${line.source}`);
        }
        console.log(`${((coveredLines / lines) * 100).toFixed(1)}% covered`);
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

export interface SavedMemory {
    memory: Uint8Array;
    symbols: { [symbol: string]: number };
}

export interface RunResult {
    /** The number of instructions executed */
    instructions: number;
    /** The number of T-states taken */
    tStates: number;
    /** The number of interrupts accepted */
    interrupts: number;
    /** The number of times each address was executed */
    coverage: Coverage;
}

export interface RunOptions {
    /**
     * Raise an interrupt every this many T-states, e.g. 69888 for a 50Hz
     * frame interrupt on a 3.5MHz ZX Spectrum
     */
    interruptEvery?: number;
    /** Make the interrupts raised by interruptEvery non-maskable */
    interruptNonMaskable?: boolean;
    steps?: number;
    call?: boolean;
    /** For call(): the stack pointer to start with */
    sp?: number | string;
    /**
     * For call(): a return address to push onto the stack before starting
     */
    returnAddress?: number | string;
    coverage?: Coverage;
}

export enum StepResponse {
    RUN,
    BREAK,
    SKIP,
}
