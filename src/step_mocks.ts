import { Zat } from './zat';
import { InstructionType } from './z80/Z80';

export class StepMock {
    private mocks: AbstractStepMock[] = [];

    constructor(private zat: Zat) {}

    mock() {
        return (pc: number) => {
            for (const mock of this.mocks) {
                if (mock.onStep(this.zat, pc)) {
                    return true;
                }
            }
            return false;
        }
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

    public setOnStep(pc: number | string, func: () => boolean) {
        pc = this.zat.getAddress(pc);
        this.mocks.push(new OnStepMock(pc, func));
        return this;
    }
}

abstract class AbstractStepMock {
    public abstract onStep(zat: Zat, pc: number): boolean;
}

class BreakpointStepMock extends AbstractStepMock {
    public constructor(private breakpoint) {
        super();
    }

    public onStep(zat: Zat, pc: number): boolean {
        return pc === this.breakpoint;
    }
}

class FakeCallStepMock extends AbstractStepMock {
    public constructor(private addr, private func: () => void) {
        super();
    }

    public onStep(zat: Zat, pc: number): boolean {
        if (pc === this.addr && (
            zat.z80.lastInstruction === InstructionType.CALL
            || zat.z80.lastInstruction === InstructionType.INT
            || zat.z80.lastInstruction === InstructionType.RST)) {
            this.func();
            zat.z80.pc = zat.z80.popWord();
        }
        return false;
    }
}

class OnStepMock extends AbstractStepMock {
    public constructor(private addr, private func: () => boolean) {
        super();
    }

    public onStep(zat: Zat, pc: number): boolean {
        if (pc === this.addr) {
            return this.func();
        }
        return false;
    }
}
