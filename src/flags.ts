import { Flag } from './vendor/z80-base';

/**
 * A view of the bits of a flags register, as 0 or 1. Setting a flag
 * changes the register.
 */
export class Flags {
    public constructor(
        private getF: () => number,
        private setF: (f: number) => void
    ) {}

    private get(flag: Flag): number {
        return this.getF() & flag ? 1 : 0;
    }

    private set(flag: Flag, value: number | boolean) {
        const f = this.getF();
        this.setF(value ? f | flag : f & ~flag);
    }

    /** Sign */
    get S() {
        return this.get(Flag.S);
    }
    set S(value: number | boolean) {
        this.set(Flag.S, value);
    }

    /** Zero */
    get Z() {
        return this.get(Flag.Z);
    }
    set Z(value: number | boolean) {
        this.set(Flag.Z, value);
    }

    /** Undocumented bit 5 */
    get Y() {
        return this.get(Flag.X5);
    }
    set Y(value: number | boolean) {
        this.set(Flag.X5, value);
    }

    /** Half carry */
    get H() {
        return this.get(Flag.H);
    }
    set H(value: number | boolean) {
        this.set(Flag.H, value);
    }

    /** Undocumented bit 3 */
    get X() {
        return this.get(Flag.X3);
    }
    set X(value: number | boolean) {
        this.set(Flag.X3, value);
    }

    /** Parity */
    get P() {
        return this.get(Flag.P);
    }
    set P(value: number | boolean) {
        this.set(Flag.P, value);
    }

    /** Overflow, which is the same bit as parity */
    get V() {
        return this.get(Flag.V);
    }
    set V(value: number | boolean) {
        this.set(Flag.V, value);
    }

    /** Subtract */
    get N() {
        return this.get(Flag.N);
    }
    set N(value: number | boolean) {
        this.set(Flag.N, value);
    }

    /** Carry */
    get C() {
        return this.get(Flag.C);
    }
    set C(value: number | boolean) {
        this.set(Flag.C, value);
    }

    /**
     * The set flags as a string, e.g. "SZ.H.P.C", with '.' for each flag that
     * isn't set. Includes the undocumented flags.
     */
    public toString() {
        return (['S', 'Z', 'Y', 'H', 'X', 'P', 'N', 'C'] as const)
            .map((flag) => (this[flag] ? flag : '.'))
            .join('');
    }
}
