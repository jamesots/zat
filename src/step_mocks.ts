import { Zat, StepResponse } from './zat';
import { InstructionType } from './instruction_type';

export class StepMock {
    private mocks: AbstractStepMock[] = [];

    constructor(private zat: Zat) {}

    onStep(pc: number): StepResponse {
        // stops at the first mock which returns a non-RUN status. A mock may
        // remove mocks, so loop over a copy, and skip any which are removed.
        for (const mock of [...this.mocks]) {
            if (!this.mocks.includes(mock)) {
                continue;
            }
            const result = mock.onStep(this.zat, pc);
            if (result !== StepResponse.RUN) {
                return result;
            }
        }
        return StepResponse.RUN;
    }

    /**
     * Replace calls to an address. This replaces any earlier fake call for
     * the same address.
     */
    public setFakeCall(pc: number | string, func: () => void) {
        const addr = this.zat.getAddress(pc);
        this.mocks = this.mocks.filter(
            (mock) => !(mock instanceof FakeCallStepMock && mock.addr === addr)
        );
        return this.add(new FakeCallStepMock(addr, func));
    }

    public setOnStep(pc: number | string, func: () => StepResponse) {
        return this.add(new OnStepMock(this.zat.getAddress(pc), func));
    }

    public setOnAllSteps(func: (pc: number) => StepResponse) {
        return this.add(new OnAllStepsMock(func));
    }

    /**
     * Add a mock, and return a function which removes it.
     */
    private add(mock: AbstractStepMock): () => void {
        this.mocks.push(mock);
        return () => {
            this.mocks = this.mocks.filter((other) => other !== mock);
        };
    }

    /**
     * Remove the mocks for an address. Mocks for all steps aren't removed.
     */
    public remove(pc: number | string) {
        const addr = this.zat.getAddress(pc);
        this.mocks = this.mocks.filter((mock) => mock.addr !== addr);
    }

    public clear() {
        this.mocks = [];
    }
}

abstract class AbstractStepMock {
    /** The address the mock is for, if it's for one address */
    public readonly addr?: number;
    public abstract onStep(zat: Zat, pc: number): StepResponse;
}

class FakeCallStepMock extends AbstractStepMock {
    public constructor(
        public readonly addr: number,
        private func: () => void
    ) {
        super();
    }

    public onStep(zat: Zat, pc: number): StepResponse {
        if (
            pc === this.addr &&
            (zat.lastInstruction === InstructionType.CALL ||
                zat.lastInstruction === InstructionType.INT ||
                zat.lastInstruction === InstructionType.RST)
        ) {
            this.func();
            zat.z80.regs.pc = zat.z80.popWord();
            zat.lastInstruction = InstructionType.RET;
            return StepResponse.SKIP;
        }
        return StepResponse.RUN;

        //TODO this is called before the instruction, and then the
        // instruction is also read
    }
}

class OnStepMock extends AbstractStepMock {
    public constructor(
        public readonly addr: number,
        private func: () => StepResponse
    ) {
        super();
    }

    public onStep(zat: Zat, pc: number): StepResponse {
        if (pc === this.addr) {
            return this.func();
        }
        return StepResponse.RUN;
    }
}

class OnAllStepsMock extends AbstractStepMock {
    public constructor(private func: (pc: number) => StepResponse) {
        super();
    }

    public onStep(zat: Zat, pc: number): StepResponse {
        return this.func(pc);
    }
}
