import { Zat, stringToBytes, hex8 } from './zat';

/**
 * Thrown when IO doesn't happen as an IoSpy expects.
 */
export class IoSpyError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'IoSpyError';
    }
}

export class IoSpy {
    private spies: AbstractIoSpy[] = [];
    private spyIndex = 0;

    constructor(private zat: Zat) {}

    public readSpy() {
        return (port: number) => {
            const returnValue = this.currentSpy(
                `IN from port ${hex8(port & 0xff)}`
            ).onRead(this.zat, port);
            if (this.spies[this.spyIndex].finished) {
                this.spyIndex++;
            }
            return returnValue;
        };
    }

    public writeSpy() {
        return (port: number, value: number) => {
            this.currentSpy(
                `OUT to port ${hex8(port & 0xff)} of ${hex8(value)}`
            ).onWrite(this.zat, port, value);
            if (this.spies[this.spyIndex].finished) {
                this.spyIndex++;
            }
        };
    }

    private currentSpy(description: string) {
        if (this.allDone()) {
            throw new IoSpyError(
                `Unexpected ${description}: all the expected IO has happened`
            );
        }
        return this.spies[this.spyIndex];
    }

    /**
     * Return values to specified ports when IO read operations occurr.
     *
     * Each value is a tuple. The first value in the tuple is the port on
     * which a read is expected; an IoSpyError is thrown if a read occurrs on
     * a different port. The second value in the tuple is the number to
     * return, or a string or array of numbers to return from successive reads.
     *
     * An IoSpyError is thrown if an IO write occurrs before all the reads
     * have happened.
     *
     * @param values tuples, or a single port and value
     */
    public onIn(...values) {
        this.spies.push(new ReturnValuesSpy(values));
        return this;
    }

    public sendIgnoringWrites(...values) {
        this.spies.push(new ReturnValuesSpy(values, true));
        return this;
    }

    /**
     * Expect values to be written to specified ports, in the same format as
     * onIn. An IoSpyError is thrown if a different value or port is written
     * to, or if an IO read occurrs before all the writes have happened.
     */
    public onOut(...values) {
        this.spies.push(new ExpectValuesSpy(values));
        return this;
    }

    public receiveIgnoringReads(...values) {
        this.spies.push(new ExpectValuesSpy(values, true));
        return this;
    }

    public allDone() {
        return this.spyIndex >= this.spies.length;
    }
}

function checkPort(zat: Zat, port: number, expectedPort, description: string) {
    const expected = zat.getAddress(expectedPort);
    if ((port & 0xff) !== expected) {
        throw new IoSpyError(
            `Expected ${description} port ${hex8(expected)}${
                typeof expectedPort === 'string' ? ` (${expectedPort})` : ''
            } but got port ${hex8(port & 0xff)}`
        );
    }
}

abstract class AbstractIoSpy {
    public finished = false;
    public abstract onRead(zat: Zat, port: number): number;
    public abstract onWrite(zat: Zat, port: number, value: number): void;
}

class ReturnValuesSpy extends AbstractIoSpy {
    private index = 0;
    private subIndex = 0;
    private subValues = [];

    public constructor(
        private values,
        private ignoreWrites = false
    ) {
        super();
        if (values.length === 0) {
            throw new IoSpyError('Must return at least one value');
        }
        if (!Array.isArray(values[0]) && values.length === 2) {
            this.values = [values];
        }
    }

    public onRead(zat: Zat, port) {
        let [expectedPort, returnValue] = this.values[this.index];
        checkPort(zat, port, expectedPort, 'IN from');
        if (typeof returnValue === 'string' && this.subIndex === 0) {
            this.subValues = stringToBytes(returnValue);
        } else if (Array.isArray(returnValue) && this.subIndex === 0) {
            this.subValues = returnValue;
        }
        if (typeof returnValue === 'string' || Array.isArray(returnValue)) {
            const num = this.subValues[this.subIndex];
            this.subIndex++;
            if (this.subIndex === returnValue.length) {
                this.subIndex = 0;
                this.index++;
                if (this.index === this.values.length) {
                    this.finished = true;
                }
            }
            return num;
        } else {
            this.index++;
            if (this.index === this.values.length) {
                this.finished = true;
            }
            return returnValue;
        }
    }

    public onWrite(zat: Zat, port, value) {
        if (!this.ignoreWrites) {
            throw new IoSpyError(
                `Expected an IN, but got OUT to port ${hex8(
                    port & 0xff
                )} of ${hex8(value)}`
            );
        }
    }
}

class ExpectValuesSpy extends AbstractIoSpy {
    private index = 0;
    private subIndex = 0;
    private subValues = [];

    public constructor(
        private values,
        private ignoreReads = false
    ) {
        super();
        if (values.length === 0) {
            throw new IoSpyError('Must expect at least one value');
        }
        if (!Array.isArray(values[0]) && values.length === 2) {
            this.values = [values];
        }
    }

    public onRead(zat: Zat, port) {
        if (!this.ignoreReads) {
            throw new IoSpyError(
                `Expected an OUT, but got IN from port ${hex8(port & 0xff)}`
            );
        }
        return 0;
    }

    public onWrite(zat: Zat, port, value) {
        let [expectedPort, expectedValue] = this.values[this.index];
        checkPort(zat, port, expectedPort, 'OUT to');
        if (typeof expectedValue === 'string' && this.subIndex === 0) {
            this.subValues = stringToBytes(expectedValue);
        } else if (Array.isArray(expectedValue) && this.subIndex === 0) {
            this.subValues = expectedValue;
        }
        if (typeof expectedValue === 'string' || Array.isArray(expectedValue)) {
            const num = this.subValues[this.subIndex];
            checkValue(value, num, port);
            this.subIndex++;
            if (this.subIndex === expectedValue.length) {
                this.subIndex = 0;
                this.index++;
                if (this.index === this.values.length) {
                    this.finished = true;
                }
            }
        } else {
            checkValue(value, expectedValue, port);
            this.index++;
            if (this.index === this.values.length) {
                this.finished = true;
            }
        }
    }
}

function checkValue(value: number, expected: number, port: number) {
    if (value !== expected) {
        throw new IoSpyError(
            `Expected OUT to port ${hex8(port & 0xff)} of ${hex8(
                expected
            )} but got ${hex8(value)}`
        );
    }
}
