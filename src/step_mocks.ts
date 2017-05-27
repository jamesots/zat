import { Zat, StepResponse } from './zat';
import { InstructionType } from './z80/Z80';

export class StepMock {
    private mocks: AbstractStepMock[] = [];

    constructor(private zat: Zat) {}

    mock(): (pc: number) => StepResponse {
        return (pc: number) => {
            // stops at the first mock which returns a non-RUN status 
            for (const mock of this.mocks) {
                const result = mock.onStep(this.zat, pc);
                if (result !== StepResponse.RUN) {
                    return result;
                }
            }
            return StepResponse.RUN;
        }
    }

    public setLogger() {
        this.mocks.push(new LoggerStepMock());
        return this;
    }

    public setBreakpoint(pc: number | string) {
        pc = this.zat.getAddress(pc);
        this.mocks.push(new BreakpointStepMock(pc));
        return this;
    }

    public setFakeCall(pc: number | string, func: () => void) {
        pc = this.zat.getAddress(pc);
        this.mocks.push(new FakeCallStepMock(pc, func));
        return this;
    }

    public setOnStep(pc: number | string, func: () => StepResponse) {
        pc = this.zat.getAddress(pc);
        this.mocks.push(new OnStepMock(pc, func));
        return this;
    }
}

abstract class AbstractStepMock {
    public abstract onStep(zat: Zat, pc: number): StepResponse;
}

class BreakpointStepMock extends AbstractStepMock {
    public constructor(private breakpoint) {
        super();
    }

    public onStep(zat: Zat, pc: number): StepResponse {
        return pc === this.breakpoint ? StepResponse.BREAK : StepResponse.RUN;
    }
}

class FakeCallStepMock extends AbstractStepMock {
    public constructor(private addr, private func: () => void) {
        super();
    }

    public onStep(zat: Zat, pc: number): StepResponse {
        if (pc === this.addr && (
            zat.z80.lastInstruction === InstructionType.CALL
            || zat.z80.lastInstruction === InstructionType.INT
            || zat.z80.lastInstruction === InstructionType.RST)) {
            this.func();
            zat.z80.pc = zat.z80.popWord();
            zat.z80.lastInstruction = InstructionType.RET;
            return StepResponse.SKIP;
        }
        return StepResponse.RUN;

        //TODO this is called before the instruction, and then the
        // instruction is also read
    }
}

class OnStepMock extends AbstractStepMock {
    public constructor(private addr, private func: () => StepResponse) {
        super();
    }

    public onStep(zat: Zat, pc: number): StepResponse {
        if (pc === this.addr) {
            return this.func();
        }
        return StepResponse.RUN;
    }
}

class LoggerStepMock extends AbstractStepMock {
    public onStep(zat: Zat, pc: number): StepResponse {
        console.log(`${zat.formatBriefRegisters()} ${zat.getSymbol(pc)}`);
        return StepResponse.RUN;
    }
}