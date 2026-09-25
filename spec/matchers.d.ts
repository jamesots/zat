// Types for zat's customMatchers, which are added with expect.extend().
export {};

declare module 'vitest' {
    interface Matchers<
        R extends void | Promise<void> = void | Promise<void>,
        T = unknown,
    > {
        toBeComplete(): R;
    }
}
