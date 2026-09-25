import * as fs from 'fs';
import * as path from 'path';
import { threadId } from 'worker_threads';
import { ListingLine } from './compiler';

/**
 * The number of times each line of each source file was executed, keyed
 * on the file's absolute path and then the line number.
 */
export type LineCoverage = Map<string, Map<number, number>>;

/**
 * Coverage collected by this process since it was last saved.
 */
let collected: LineCoverage = new Map();

export const DEFAULT_COVERAGE_DIR = path.join(
    'node_modules',
    '.cache',
    'zat',
    'coverage'
);

export const DEFAULT_LCOV_FILE = path.join('coverage', 'z80', 'lcov.info');

const existingFiles = new Map<string, boolean>();

/**
 * Whether coverage should be recorded for a line: it must be from a file
 * (not code passed to compile() as a string), and be code, not data.
 */
export function isCoverable(line: ListingLine): boolean {
    let exists = existingFiles.get(line.file);
    if (exists === undefined) {
        exists = fs.existsSync(line.file) && fs.statSync(line.file).isFile();
        existingFiles.set(line.file, exists);
    }
    return exists && !line.data;
}

/**
 * Record that a line can be executed, so it's reported even if it isn't.
 */
export function addLine(file: string, line: number) {
    addCount(collected, file, line, 0);
}

/**
 * Record that a line was executed.
 */
export function lineExecuted(file: string, line: number) {
    addCount(collected, file, line, 1);
}

function addCount(
    coverage: LineCoverage,
    file: string,
    line: number,
    count: number
) {
    let lines = coverage.get(file);
    if (!lines) {
        lines = new Map();
        coverage.set(file, lines);
    }
    lines.set(line, (lines.get(line) ?? 0) + count);
}

/**
 * The coverage collected by this process since it was last saved.
 */
export function getCoverage(): LineCoverage {
    return collected;
}

/**
 * Save the coverage collected by this process to a new file in dir, and
 * clear it. Call this after each test file, e.g. in afterAll().
 */
export function saveCoverage(dir = DEFAULT_COVERAGE_DIR) {
    if (collected.size === 0) {
        return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const json: { [file: string]: [number, number][] } = {};
    for (const [file, lines] of collected) {
        json[file] = [...lines];
    }
    const name = `${process.pid}-${threadId}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(json));
    collected = new Map();
}

/**
 * Delete saved coverage. Call this before running the tests, e.g. in a
 * global setup.
 */
export function clearSavedCoverage(dir = DEFAULT_COVERAGE_DIR) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Read and combine all the saved coverage in dir.
 */
export function readSavedCoverage(dir = DEFAULT_COVERAGE_DIR): LineCoverage {
    const coverage: LineCoverage = new Map();
    if (!fs.existsSync(dir)) {
        return coverage;
    }
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) {
            continue;
        }
        const json = JSON.parse(
            fs.readFileSync(path.join(dir, name)).toString()
        ) as { [file: string]: [number, number][] };
        for (const [file, lines] of Object.entries(json)) {
            for (const [line, count] of lines) {
                addCount(coverage, file, line, count);
            }
        }
    }
    return coverage;
}

/**
 * Format coverage as lcov tracefile data.
 */
export function formatLcov(coverage: LineCoverage): string {
    const records = [];
    for (const file of [...coverage.keys()].sort()) {
        const lines = [...coverage.get(file)!].sort(([a], [b]) => a - b);
        records.push(
            [
                'TN:',
                `SF:${file}`,
                ...lines.map(([line, count]) => `DA:${line},${count}`),
                `LF:${lines.length}`,
                `LH:${lines.filter(([, count]) => count > 0).length}`,
                'end_of_record',
            ].join('\n')
        );
    }
    return records.map((record) => `${record}\n`).join('');
}

/**
 * Combine all the saved coverage in dir, and write it to an lcov file.
 * Call this after running the tests, e.g. in a global teardown.
 */
export function writeLcov(
    file = DEFAULT_LCOV_FILE,
    dir = DEFAULT_COVERAGE_DIR
) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatLcov(readSavedCoverage(dir)));
}
