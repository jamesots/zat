import { Zat, stringToBytes } from './zat';

export class IoSpy {
    private spies: AbstractIoSpy[] = [];
    private spyIndex = 0;

    constructor(private zat: Zat) {}

    public readSpy() {
        return (port: number) => {
            const returnValue = this.spies[this.spyIndex].onRead(
                this.zat,
                port
            );
            if (this.spies[this.spyIndex].finished) {
                this.spyIndex++;
            }
            return returnValue;
        };
    }

    public writeSpy() {
        return (port, value) => {
            this.spies[this.spyIndex].onWrite(this.zat, port, value);
            if (this.spies[this.spyIndex].finished) {
                this.spyIndex++;
            }
        };
    }

    /**
     * Return values to specified ports when IO read operations occurr.
     *
     * The values array contains an array of tuples. The first value in the tuple
     * is the port on which a read is expected. The test will fail if a read occurrs
     * on a different port. The second value in the tuple is the number to return.
     *
     * If more IO reads occurr than there are values in the array, the test will fail,
     * and 0 will be returned.
     *
     * @param values an array of tuples
     */
    public onIn(...values) {
        this.spies.push(new ReturnValuesSpy(values));
        return this;
    }

    public sendIgnoringWrites(...values) {
        this.spies.push(new ReturnValuesSpy(values, true));
        return this;
    }

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

abstract class AbstractIoSpy {
    public finished = false;
    public abstract onRead(zat: Zat, port: number): number;
    public abstract onWrite(zat: Zat, port: number, value: number): void;
}

class ReturnValuesSpy extends AbstractIoSpy {
    private index = 0;
    private subIndex = 0;
    private subValues = [];

    public constructor(private values, private ignoreWrites = false) {
        super();
        if (values.length === 0) {
            fail('Must return at least one value');
        }
        if (!Array.isArray(values[0]) && values.length === 2) {
            this.values = [values];
        }
    }

    public onRead(zat: Zat, port) {
        let [expectedPort, returnValue] = this.values[this.index];
        expectedPort = zat.getAddress(expectedPort);
        expect(port & 0xff).toBe(expectedPort);
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
            fail('Not expecting an IO write at this point');
        }
    }
}

class ExpectValuesSpy extends AbstractIoSpy {
    private index = 0;
    private subIndex = 0;
    private subValues = [];

    public constructor(private values, private ignoreReads = false) {
        super();
        if (values.length === 0) {
            fail('Must expect at least one value');
        }
        if (!Array.isArray(values[0]) && values.length === 2) {
            this.values = [values];
        }
    }

    public onRead(zat: Zat, port) {
        if (!this.ignoreReads) {
            fail('Not expecting an IO read at this point');
        }
        return 0;
    }

    public onWrite(zat: Zat, port, value) {
        let [expectedPort, expectedValue] = this.values[this.index];
        expectedPort = zat.getAddress(expectedPort);
        expect(port & 0xff).toBe(expectedPort);
        if (typeof expectedValue === 'string' && this.subIndex === 0) {
            this.subValues = stringToBytes(expectedValue);
        } else if (Array.isArray(expectedValue) && this.subIndex === 0) {
            this.subValues = expectedValue;
        }
        if (typeof expectedValue === 'string' || Array.isArray(expectedValue)) {
            const num = this.subValues[this.subIndex];
            expect(value).toBe(num);
            this.subIndex++;
            if (this.subIndex === expectedValue.length) {
                this.subIndex = 0;
                this.index++;
                if (this.index === this.values.length) {
                    this.finished = true;
                }
            }
        } else {
            expect(value).toBe(expectedValue);
            this.index++;
            if (this.index === this.values.length) {
                this.finished = true;
            }
        }
    }
}
