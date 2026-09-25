import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['spec/**/*.spec.ts'],
        setupFiles: ['spec/setup.ts'],
        globalSetup: ['spec/global-setup.ts'],
    },
});
