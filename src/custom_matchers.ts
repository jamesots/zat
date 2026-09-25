import { IoSpy } from './io_spies';

/**
 * Custom matchers, for use with expect.extend() in Vitest or Jest.
 */
export const customMatchers = {
    toBeComplete(actual: IoSpy) {
        return {
            pass: actual.allDone(),
            message: () =>
                actual.allDone()
                    ? 'Expected IO not to be complete'
                    : 'Expected all IO to have happened',
        };
    },
};
