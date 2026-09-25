import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['spec/**/*.spec.ts'],
        setupFiles: ['spec/setup.ts'],
        globalSetup: ['spec/global-setup.ts'],
        // Z80 source files aren't imported by the tests, so Vitest doesn't
        // know to re-run them in watch mode when they change
        forceRerunTriggers: [
            ...configDefaults.forceRerunTriggers,
            '**/*.z80',
            '**/*.asm',
            '**/*.inc',
        ],
    },
});
