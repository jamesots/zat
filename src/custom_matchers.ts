import { IoSpy } from './io_spies';

export const customMatchers: jasmine.CustomMatcherFactories = {
    toBeComplete: function (
        util: jasmine.MatchersUtil,
        customEqualityTesters: jasmine.CustomEqualityTester[]
    ): jasmine.CustomMatcher {
        return {
            compare: function (
                actual: IoSpy,
                expected
            ): jasmine.CustomMatcherResult {
                const result: jasmine.CustomMatcherResult = {
                    pass: true,
                    message: '',
                };
                if (!actual.allDone()) {
                    result.pass = false;
                    result.message = 'Expected all io to have been read';
                }
                return result;
            },
        };
    },
};
