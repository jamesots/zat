import { Runner, Delegate, CpuEvent } from 'z80-test';
import { Z80, Hal, RegisterSet } from '../src/zat';

/**
 * Runs the FUSE emulator's Z80 tests against the emulator.
 */
class TestDelegate implements Delegate {
    private memory = new Uint8Array(65536);
    private hal: Hal = {
        tStateCount: 0,
        readMemory: (address) => this.memory[address],
        writeMemory: (address, value) => (this.memory[address] = value),
        contendMemory: () => {},
        // The tests expect the upper byte of the port address
        readPort: (address) => address >> 8,
        writePort: () => {},
        contendPort: () => {},
    };
    private z80 = new Z80(this.hal);

    public startNewTest() {
        this.z80.reset();
        this.memory.fill(0);
        this.hal.tStateCount = 0;
    }

    public setRegister(register: string, value: number) {
        this.z80.regs[register as keyof RegisterSet] = value as never;
    }

    public getRegister(register: string): number {
        return this.z80.regs[register as keyof RegisterSet] as number;
    }

    public run(tStateCount: number): CpuEvent[] {
        while (this.hal.tStateCount < tStateCount) {
            this.z80.step();
        }
        return [];
    }

    public writeMemory(address: number, value: number) {
        this.memory[address] = value;
    }

    public readMemory(address: number) {
        return this.memory[address];
    }

    public getTStateCount() {
        return this.hal.tStateCount;
    }
}

describe('Z80 emulator', function () {
    it('should pass the FUSE tests', function () {
        const runner = new Runner(new TestDelegate());
        runner.checkEvents = false;
        runner.checkTStates = true;
        runner.checkContend = false;
        runner.loadTests();
        runner.runAll();
        // The z80-test package on npm is from 2021. Since then, upstream has
        // changed how SCF and CCF set the undocumented flag bits, to match
        // FUSE, and updated these two tests to match (trs80 commit 178fef2f).
        expect(runner.errors).toEqual([
            '37_1: expected register af to be 00C5 but was 00ED',
            '3f: expected register af to be 0050 but was 0058',
        ]);
        expect(runner.successfulTests).toBe(runner.tests.size - 2);
    });
});
