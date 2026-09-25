import { afterAll } from 'vitest';
import { saveCoverage } from '../src/zat';

// Save the Z80 code coverage from each test file
afterAll(() => saveCoverage());
