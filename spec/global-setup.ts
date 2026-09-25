import { clearSavedCoverage, writeLcov } from '../src/zat';

export function setup() {
    clearSavedCoverage();
}

// Combine the Z80 code coverage from all the test files into
// coverage/z80/lcov.info
export function teardown() {
    writeLcov();
}
